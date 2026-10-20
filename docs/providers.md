# Providers

marsClaw runs against one of two agent SDKs, chosen once at boot for the whole process. Switch without code changes (restart required).

| Provider | Runtime                                | Auth                                       | Tools                                                                 |
|---|---|---|---|
| `claude` | `@anthropic-ai/claude-agent-sdk` (in-process, or in a container) | Claude OAuth (Pro/Max), `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` | Read, Write, Edit, MultiEdit, Glob, Grep, Task (+ Bash / WebFetch / WebSearch when enabled) + our MCP suite |
| `gemini` | `@google/gemini-cli-core` (in-process) | Google login OAuth (`~/.gemini/oauth_creds.json`) | Text only — no tool calling on this path |

## Switching providers

```bash
bun run provider              # interactive
bun run provider claude
bun run provider gemini
```

Writes `AGENT_PROVIDER=<name>` to `.env` (installing the CLI with `npm install -g` if it isn't on PATH, and warning if you're not logged in yet). **Restart the bot** (`bun run service restart`, or Ctrl-C + `bun run start`) — the provider is resolved once when the process starts. Because env beats `data/config.json`, the `.env` line is what counts.

## Claude

Implementation: [src/providers/claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts).

### How it works

- **One long-lived `query()` per thread.** The SDK boots a subprocess + MCP server (~10s) on first message, then each new turn pushes an `SDKUserMessage` into the same async iterable. Cold-start is paid once per chat, not per message.
- **Session continuity.** The SDK persists the transcript to `~/.claude`. If a session is recycled (idle timeout, crash), the next message resumes from the `session_id` stored in SQLite. If that id can't be resumed, it is cleared and the turn retries fresh. A fresh session with no stored id gets the last 20 SQLite turns folded into its first message, so switching from Gemini doesn't lose context.
- **Capacity.** Sessions are kept in an LRU map capped at `config.max_sessions` (default 20). A flood of new threads cannot OOM the host.
- **Idle / age teardown.** Sessions are recycled after `idle_ms` of inactivity (default 15 min) or `max_session_age_ms` total lifetime (default 4 h), whichever first. Hard cap exists to bound slow leaks in the SDK subprocess / MCP child / third-party deps.
- **Stuck-turn sweep.** Every 30s a sweep kills a turn that's past `MARSCLAW_AGENT_TIMEOUT_MS` + 60s, or older than 60s with no heartbeat for 60s.
- **Retries.** A transient error (rate limit, 5xx, socket reset) is retried once with a fresh session after 2s.
- **Persona.** The `claude_code` system-prompt preset + `CLAUDE.md` (via `settingSources`) + an appended chat persona (bot name, owner name, researcher rule). Claude Code UI tools (`TodoWrite`, `ScheduleWakeup`, plan/worktree tools) are removed.
- **Runtime.** With `runtime: container` the same loop runs inside the agent container instead — see [container-runtime.md](container-runtime.md). Gemini always runs in-process.

### Auth

```bash
claude   # interactive login the first time
```

Subsequent `claude` invocations reuse the token (`~/.claude.json`). marsClaw's setup auto-detects this. For headless / metered usage:

```env
ANTHROPIC_API_KEY=sk-ant-…
```

### Tool gate

In-process, every tool call passes through `canUseTool` in [src/lib/tool-permissions.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/tool-permissions.ts) (with `permissionMode: 'default'`):

- `Bash`, `WebFetch`, `WebSearch` are removed from the model's tool list unless `allow_shell` / `allow_web` are on, and denied by the gate as a backstop.
- Filesystem-touching tools (`Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `NotebookEdit`) are refused on sensitive paths first, then restricted to `allowed_paths`. `Grep`/`Glob` also refuse a root that contains a sensitive subtree.
- `WebFetch` is limited to `allowed_web_domains`.
- `Bash` (when enabled) adds the destructive-command denylist plus your `extra_bash_denylist`.
- Write-style tools auto-`mkdir -p` the parent directory so the agent doesn't need a separate Bash step.
- MCP tools (`mcp__*`) always pass here — dangerous ones gate themselves inside the MCP server (see the mutation gate in [security.md](security.md)).
- Every decision is written to `logs/audit.log`.

In container mode the gate is built with `{ contained: true }`, which allows everything (the container is the boundary).

### Cost tracking

[src/lib/cost-tracker.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/cost-tracker.ts) appends each turn's `total_cost_usd` and token counts to `data/usage.jsonl` and sums the current UTC day. New turns refuse once spend exceeds `daily_usd_budget` (config.json). The check only runs when `ANTHROPIC_API_KEY` is set — under OAuth there's no per-token billing. In-process turns only; container-mode turns aren't recorded.

Inspect:

```bash
bun run usage today
bun run usage week
bun run usage by-thread
```

### Failover

If Claude returns a "hard error" — quota exhausted, auth broken — and Gemini is authed, marsClaw fails over to Gemini for that turn so the user still gets an answer (both in-process and container mode):

```
claude hard error — failing over to gemini
```

If Gemini isn't authed, the user gets Claude's friendly error text instead.

Hard errors are classified in [src/providers/claude-error.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-error.ts).

## Gemini

Implementation: [src/providers/gemini-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/gemini-sdk.ts).

### How it works

- **In-process inference.** Reuses the OAuth credentials at `~/.gemini/oauth_creds.json` that the `gemini` CLI writes (`AuthType.LOGIN_WITH_GOOGLE`). No subprocess. First use pays ~10s of init.
- **History from SQLite.** Each turn re-sends the last 20 turns from the `messages` table, so we don't fight the SDK's chat-state model.
- **Persona.** `GEMINI.md` (+ its `@imports`) is loaded by the core's memory loader and prepended as the system instruction.
- **No tool calling.** No MCP tools, no `speak`, no file access. Use Claude if you need tools.

### Auth

```bash
gemini   # interactive login the first time → ~/.gemini/oauth_creds.json
```

`GEMINI_API_KEY` in `.env` makes setup and the failover check treat Gemini as logged in, but the in-process path still authenticates with the OAuth login above — the key is not used for inference today.

### Model

`GEMINI_MODEL=gemini-2.5-flash` by default. Override in `.env`.

### Quota

Gemini OAuth free tier has a daily quota that resets every 16–24h. When exhausted the bot replies with a friendly note instead of going silent:

> I've hit my daily Gemini quota. Try again later or switch providers (`bun run setup` → claude).

Rate limits and expired auth get their own one-liners; anything else replies `Sorry — Gemini errored on that one. (…)`.

Errors are classified in [src/agent.ts](https://github.com/deBilla/marsclaw/blob/main/src/agent.ts) (`geminiFriendlyError`).

## Comparison

| | Claude | Gemini |
|---|---|---|
| Tool use | ✓ fs + MCP (shell, web opt-in) | ✗ text only |
| Image input | ✓ via `Read` of a downloaded path | ✗ |
| Voice replies | ✓ `speak` | ✗ |
| Cold start | ~10s once per chat | ~10s once per process |
| Per-message latency | ~1–5s warm | ~1–3s warm |
| Auth | Claude Pro/Max OAuth, or metered API key | Google login OAuth (free tier) |
| Cost ceiling | `daily_usd_budget` enforces a cap (metered only) | Quota is upstream-imposed |
| Failover target | Gemini, when authed | none |
