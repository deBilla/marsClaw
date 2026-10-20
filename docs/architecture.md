# Architecture

marsClaw is one Bun process (plus one MCP child per active Claude thread, and optional voice / container sidecars). SQLite holds the chat state — messages, outbox, sessions, approvals; a few flat files hold the rest (`MEMORY.md`, `data/usage.jsonl`, `logs/audit.log`). The agent SDK does the LLM work; we glue channels and tools to it.

## Message flow

```
┌────────────────────────────┐         ┌──────────────────────────────────────┐
│  channel adapter           │ text ─▶ │  handleMessage (src/agent.ts)        │
│  · telegram                │         │  · append to sqlite messages         │
│  · slack                   │         │  · build per-turn context            │
│  · whatsapp                │ voice?▶ │     (time, timezone, location)       │
└────────────────────────────┘ whisper │  · runClaudeSdk OR runGeminiSdk      │
        ▲                      :9000   │  · trim reply, append, send          │
        │                              └────────────┬─────────────────────────┘
        │                                           │
        │                          speak / send_file│   ← MCP (stdio, or HTTP in container mode)
        │                          send_message     │
        │                          gmail/calendar…  │
        │                                           ▼
        └──────────  router.send  ◀──── outbox drain (250ms / 5s tick)
```

Single dispatcher in [src/index.ts](https://github.com/deBilla/marsclaw/blob/main/src/index.ts) intercepts mutation-approval replies, then serializes per thread: two messages from the same chat never run two agent calls in parallel. The outbox is the only path for asynchronous side-channel messages — the agent's MCP tools (which run in a separate process) enqueue rows, the drain loop delivers them.

## Two runtimes

The flow above is the **`in-process`** runtime (default): the agent SDK loop runs inside the host bot process and is secured by capability removal (path gates, no shell/web, sensitive-path guard).

Setting `runtime: container` (or `MARSCLAW_RUNTIME=container`) keeps everything left of `handleMessage` identical — channels, per-thread serialization, SQLite, the outbox drain — but the host becomes a **broker** that ships each turn over `POST /turn` to an isolated agent container, with the real Anthropic credential, Google OAuth, and web egress held by host-side sidecars. The container holds no secrets; security shifts from capability removal to isolation. Full detail, the host/sidecar diagram, and the per-mode security table are in [container-runtime.md](container-runtime.md).

## Components

| Layer                       | Where                                                     | Notes |
|---|---|---|
| Process root                | [src/index.ts](https://github.com/deBilla/marsclaw/blob/main/src/index.ts)                           | Circuit-breaker backoff, channels, approval interceptor, per-thread dispatcher, outbox drain, backup schedule, health server, audit alerter; boots container sidecars when `runtime: container`. |
| Per-turn handler            | [src/agent.ts](https://github.com/deBilla/marsclaw/blob/main/src/agent.ts)                           | Builds turn context, runs the provider (in-process or container), Claude→Gemini failover, typing refresher. |
| Channel router              | [src/channels/router.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/router.ts)       | Dispatches by thread-id prefix: `telegram:`, `slack:`, `whatsapp:`. |
| Channel adapters            | [src/channels/](https://github.com/deBilla/marsclaw/blob/main/src/channels/)                         | One file per channel. Each applies its own sender allow-list and rate limit before calling `onMessage`. |
| Provider registry           | [src/providers/registry.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/registry.ts) | Selects Claude or Gemini from `agent_provider` **once at boot** (restart to switch). |
| Claude path (in-process)    | [src/providers/claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts) | Long-lived `query()` per thread via `@anthropic-ai/claude-agent-sdk`. LRU cap, idle/age/stuck sweeps, researcher subagent. |
| Claude path (container)     | [src/providers/container-client.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/container-client.ts), [container-runtime.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/container-runtime.ts) | `POST /turn` to the agent container; lazy start / idle stop; host sidecars. |
| Gemini path                 | [src/providers/gemini-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/gemini-sdk.ts) | In-process inference via `@google/gemini-cli-core`. Text only. |
| MCP server                  | [src/mcp/build-server.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/build-server.ts)     | One tool list, two transports: stdio ([server.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/server.ts), one child per thread) and HTTP ([http-server.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/http-server.ts), container mode). |
| Per-call tool gate          | [src/lib/tool-permissions.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/tool-permissions.ts) | Capability flags, `allowed_paths`, sensitive-path guard, Grep/Glob recursion gate, web allow-list, Bash denylist. |
| Mutation gate               | [src/lib/mutation-gate.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/mutation-gate.ts), [approval-gate.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/approval-gate.ts) | Google writes: refuse, allow, or per-call operator approval. Runs inside the MCP server. |
| SQLite                      | [src/db/](https://github.com/deBilla/marsclaw/blob/main/src/db/)                                     | `messages`, `outbox`, `sessions`, `pending_approvals`, `schema_migrations`. |
| Config                      | [src/lib/config.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/config.ts)                 | `data/config.json` + env overlay, read once and frozen. Refuses to start on an unparseable config. |

### MCP servers the agent sees

- **`marsclaw`** — our own server (channel + Google + YouTube tools). Listed in [.mcp.json](https://github.com/deBilla/marsclaw/blob/main/.mcp.json) for the `claude` CLI; the bot itself wires it programmatically in `claude-sdk.ts` (stdio) or the agent container (HTTP).
- **`data-platform`** — an external, read-only BigQuery MCP server. It is **hard-coded** in `mcpServers()` in [claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts) to a path under the author's home directory (`/Users/dimuthu/mp-ai/data-platform-mcp`), is in-process only (not wired into container mode), and receives `BQ_*` / `GOOGLE_APPLICATION_CREDENTIALS` env. On any other machine that path won't exist and the server simply fails to start; remove the entry if you fork.

## Thread IDs

Every channel writes thread IDs prefixed with its name. The router dispatches outbound sends back to the right adapter using that prefix.

| Channel    | Format example                              |
|---|---|
| Telegram   | `telegram:123456789` (chat id)              |
| Slack      | `slack:D0123456789` (channel / DM id, not user id) |
| WhatsApp   | `whatsapp:94701234567@s.whatsapp.net` or `whatsapp:…@lid` |

## SQLite schema

`data/marsclaw.db` (override with `MARSCLAW_DB`). Migrations live in [migrations/](https://github.com/deBilla/marsclaw/blob/main/migrations/) and run on every boot; applied versions are tracked in a `schema_migrations` table.

**messages**

| col | type | notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| thread_id | TEXT | channel-prefixed |
| role | TEXT | `user` or `assistant` (CHECK constraint) |
| text | TEXT | raw (no per-turn context decoration) |
| created_at | INTEGER | unix epoch seconds |

**outbox** — async messages queued by the agent's MCP tools (and by the approval gate).

| col | type | notes |
|---|---|---|
| id | INTEGER PK | |
| thread_id | TEXT | |
| text | TEXT | reply text (or caption when `file_path` is set) |
| audio_path | TEXT? | when set, channel sends as voice note |
| file_path | TEXT? | when set, channel sends as document/image |
| file_name | TEXT? | display name override |
| attempts | INTEGER | retry counter (cap = `MAX_ATTEMPTS` = 3) |
| delivered_at | INTEGER? | non-null when sent |
| failed_at | INTEGER? | non-null when permanently failed |
| last_error | TEXT? | last delivery error |
| created_at | INTEGER | |

**sessions** — provider session continuity (Claude SDK resume).

| col | type | notes |
|---|---|---|
| thread_id | TEXT PK | |
| provider | TEXT | `claude` |
| session_id | TEXT | resumed across restarts |
| updated_at | INTEGER | |

**pending_approvals** — per-call mutation approvals (`mutation_approval: "all"`).

| col | type | notes |
|---|---|---|
| id | INTEGER PK | |
| thread_id | TEXT | chat the prompt was sent to |
| nonce | TEXT | `ok-XXXXXX`, generated by the broker |
| tool | TEXT | e.g. `gmail_send`, `calendar_raw (events.patch)` |
| summary | TEXT | structured rendering shown to the operator |
| status | TEXT | `pending` / `approved` / `denied` / `expired` |
| created_at / expires_at | INTEGER | 120 s window |

## Per-turn flow

1. Adapter receives a message, drops it if the sender isn't on the channel allow-list or is over the rate limit, and calls `onMessage(threadId, text)`. WhatsApp additionally handles single-word `stop` / `cancel` / `abort` (interrupts the in-flight turn without queueing) and silently drops CLI slash-commands like `/help` or `/clear`.
2. `src/index.ts` first checks for a pending mutation approval: if the text contains that thread's nonce, it is consumed here and never reaches the agent.
3. Otherwise the call is chained onto an in-memory `inFlight` promise keyed by `threadId` — serialized per thread, parallel across threads.
4. `handleMessage` ([src/agent.ts](https://github.com/deBilla/marsclaw/blob/main/src/agent.ts)) appends to `messages`, builds the per-turn context line (current local time, timezone, location), and calls the selected provider.
5. **Claude path:** SDK `query()` is long-lived per thread (subprocess + MCP boot once, ~10s); subsequent messages stream into the same iterable. A fresh session with no stored `session_id` is seeded with the last 20 turns from SQLite. In container mode the same happens inside the box, reached over `POST /turn`.
6. **Gemini path:** in-process inference via `@google/gemini-cli-core`. Re-sends the last 20 turns from SQLite each call.
7. The reply is trimmed; empty replies are skipped (that's how a `speak`-only voice reply works). Non-empty replies append to `messages` and send through the channel.
8. While the agent is working, a typing refresher fires `channel.setTyping` every 4s, gated on heartbeat freshness. Only WhatsApp implements `setTyping` today.
9. The MCP tools (`send_message`, `send_file`, `speak`, approval prompts) write rows to `outbox`; a tick-based drain (250ms while draining, 5s idle) delivers them, retrying up to 3 times.

## What you don't see

- **Circuit breaker.** `enforceStartupBackoff` ([src/lib/circuit-breaker.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/circuit-breaker.ts)) sleeps with an escalating backoff (capped at 15 min) when the process restarts repeatedly within an hour; a clean shutdown resets it. State: `data/circuit-breaker.json`.
- **Heartbeat file.** Every SDK message touches `data/heartbeat`. The typing refresher, the stuck-session sweep (kills a turn with no heartbeat for 60s, or past timeout + 60s), and the health endpoint read it.
- **Cost tracker.** [src/lib/cost-tracker.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/cost-tracker.ts) appends `total_cost_usd` per turn to `data/usage.jsonl`. New turns refuse if today's (UTC) spend exceeds `daily_usd_budget` — but only when `ANTHROPIC_API_KEY` is set; OAuth bypasses the check. Container-mode turns are not recorded.
- **Conversation archive.** [src/lib/conversation-archive.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/conversation-archive.ts) writes `conversations/<thread>-<ts>.md` whenever the Claude SDK compacts context (`compact_boundary`), so the pre-compaction history isn't lost.
- **Backups.** [src/lib/backup.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/backup.ts) snapshots `marsclaw.db`, `MEMORY.md`, and `data/whatsapp-auth/` daily into `data/backups/`.
- **Health server.** [src/lib/health-server.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/health-server.ts) — `GET /health` on `127.0.0.1`, **off unless `MARSCLAW_HEALTH_PORT` is set**.
- **Audit log + alerter.** Every tool decision goes to `logs/audit.log`; ≥5 denials in 60s sends one alert to the owner's chat (5-min cooldown).
- **Crash dumps.** The logger keeps the last 200 lines in memory and writes them to `crashes/<ts>.txt` on an uncaught exception.

## What we deliberately delegate

The agent SDK owns: multi-turn tool use, planning, retries, context compaction, prompt caching (Claude), LLM auth and rate-limit handling, and the built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch). That is roughly the hardest 80% of building an agent. Anthropic's and Google's teams iterate on it daily. Outsourcing it is leverage, not laziness.
