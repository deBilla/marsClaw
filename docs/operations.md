# Operations

Running marsClaw as a long-lived service: launchd integration, backups, observability, and the troubleshooting cheatsheet.

## Run as a launchd service (macOS)

Foreground `bun run start` is fine while you tinker. For "always on", install the user-level launchd agent:

```bash
bun run service install     # render plist with resolved paths, copy to ~/Library/LaunchAgents, bootstrap
bun run service install --hardened   # legacy supervisor plist (egress gateway / LLM proxy / sandbox) — see security.md
bun run service status      # loaded? log paths? binary still in place?
bun run service start
bun run service restart     # kickstart -k → SIGTERM, respawns into current code (use after pulling)
bun run service stop        # bootout (KeepAlive won't respawn); plist stays
bun run service uninstall
bun run service logs        # tail logs/marsclaw.log
```

The agent runs as your user (no root), with `KeepAlive=true` so a crash respawns. The plist sets `MARSCLAW_LOG_FILE=logs/marsclaw.log`, so the structured log goes there; stdout/stderr from launchd itself go to `logs/launchd-stdout.log` / `logs/launchd-stderr.log` as a fallback for early-boot crashes. macOS only — on Linux, run `bun run start` under systemd (or similar) and set `MARSCLAW_LOG_FILE` yourself.

Plist template: [launchd/com.marsclaw.plist](https://github.com/deBilla/marsclaw/blob/main/launchd/com.marsclaw.plist). Implementation: [src/cli/service.ts](https://github.com/deBilla/marsclaw/blob/main/src/cli/service.ts), [src/lib/launchd.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/launchd.ts).

## Backups

Daily backups while the bot runs, kept for 7 days by default, written by [src/lib/backup.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/backup.ts):

| Target               | Destination                                            |
|---|---|
| `data/marsclaw.db`   | `data/backups/marsclaw-YYYY-MM-DD.db` (via `VACUUM INTO`) |
| `MEMORY.md`          | `data/backups/MEMORY-YYYY-MM-DD.md`                    |
| `data/whatsapp-auth/`| `data/backups/whatsapp-auth-YYYY-MM-DD.tar.gz`         |

```bash
bun run backup       # one-shot — does the same thing
```

Override location and retention via env:

| Key | Default |
|---|---|
| `MARSCLAW_BACKUP_DIR` | `data/backups` |
| `MARSCLAW_BACKUP_KEEP` | `7` (days) |

## Observability

### Status snapshot

```bash
bun run status
```

Shows provider, DB stats, and recent threads. Implemented in [src/cli/status.ts](https://github.com/deBilla/marsclaw/blob/main/src/cli/status.ts). For container mode, `bun run container status` shows runtime, daemon, credentials and sidecar/container state.

### Usage / spend

```bash
bun run usage today
bun run usage week
bun run usage by-thread
```

Reads `data/usage.jsonl` — one line per successful in-process Claude turn with tokens and `total_cost_usd` (UTC days). Under Claude Pro/Max OAuth the cost is the API-equivalent figure, not money spent. Container-mode turns aren't recorded.

### DB maintenance

```bash
bun run db stats           # path, file size, row counts per table
bun run db integrity       # PRAGMA integrity_check
bun run db vacuum          # reclaim space; brief write lock
```

### Logs

`logs/marsclaw.log` is the main log when `MARSCLAW_LOG_FILE` points at it (the launchd plist does; a foreground `bun run start` logs to the terminal only). Rotation: [src/lib/log-rotate.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/log-rotate.ts) rotates at 10 MB and keeps 5 files (`MARSCLAW_LOG_MAX_BYTES`, `MARSCLAW_LOG_ROTATIONS`). Container-mode sidecars log to `logs/llm-proxy.log`, `logs/mcp-http.log`, `logs/egress.log`; voice sidecars to `data/voice-*.log`. On an uncaught exception the last 200 log lines are dumped to `crashes/<ts>.txt`.

```bash
tail -f logs/marsclaw.log
LOG_LEVEL=debug bun run start    # noisier
```

Levels: `debug` / `info` / `warn` / `error` / `fatal`.

### Health endpoint

[src/lib/health-server.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/health-server.ts) is **off by default**. Set `MARSCLAW_HEALTH_PORT=8787` (any port) and it serves `GET /health` on `127.0.0.1` only:

```json
{ "ok": true, "uptime_s": 12345, "pid": 45057, "heartbeat_age_ms": 532,
  "channels": ["whatsapp"], "outbox": { "pending": 0, "failed": 0 },
  "db": { "path": "data/marsclaw.db", "size_kb": 80, "messages": 144, "threads": 5 },
  "today_spend_usd": 0.0123, "daily_budget_usd": 5 }
```

It also reports whether WhatsApp needs a re-scan (`data/whatsapp-needs-reauth`). Always returns 200; alert on the body.

### Heartbeat file

Every Claude SDK message touches `data/heartbeat`. External tooling can mtime-check this to detect stuck turns; the bot's own sweep kills a turn whose heartbeat has been silent for 60s.

### Audit log

Every tool decision (allow, deny, mutation-blocked) lands as one JSON line in `logs/audit.log` — separate from the app log so it can be reasoned about / shipped on its own. Override the path with `MARSCLAW_AUDIT_LOG`. Each record carries `ts`, `pid`, `tool`, `decision`, `layer` (which gate decided), an optional `reason`, and a redacted `subject` (URL, file path, command preview). See [security.md](security.md) for the schema and inspection recipes.

```bash
grep '"decision":"deny"' logs/audit.log | tail
grep '"layer":"mutation-gate"' logs/audit.log
grep '"tool":"WebFetch"' logs/audit.log
```

It's a local, append-only forensic trail — not tamper-resistant against host compromise, and not rotated in-process (use `logrotate`/`newsyslog` if it grows). Ship to a remote sink (syslog or similar) if you need tamper-evidence.

**Denial alerts.** ≥5 denials within 60s sends one summary to the owner's chat (5-min cooldown). The target thread is `MARSCLAW_ALERT_THREAD`, or auto-picked when WhatsApp or Telegram has exactly one allow-listed sender; otherwise a boot warning says alerts are inactive.

## Updating

```bash
bun run update           # backup, git pull --ff-only, bun install, service restart
bun run update --force   # proceed even with a dirty working tree (use with care)
```

Source: [src/cli/update.ts](https://github.com/deBilla/marsclaw/blob/main/src/cli/update.ts).

## Smoke test

```bash
bun run smoke
bun run smoke "what is 2+2"
```

Fires a synthetic message all the way through `handleMessage` against a fresh in-memory DB and a mock channel, and asserts a non-empty reply. Doesn't go through a real channel — useful for verifying provider auth and tool wiring without messaging yourself. It calls the real model, so it costs a turn. Source: [src/cli/smoke.ts](https://github.com/deBilla/marsclaw/blob/main/src/cli/smoke.ts).

## Hardening defaults you should know about

For the full threat model, capability flags, and residual risks, see [security.md](security.md). Operationally:

| Mechanism | Where | Effect |
|---|---|---|
| Capability flags (off by default) | `allow_shell`, `allow_web`, `allow_mutating_tools`, `mutation_approval` in `data/config.json` | No shell, no `WebFetch`/`WebSearch`, no outbound/mutating Google calls until you opt in. Out-of-the-box the agent has no third-party egress path (in-process runtime). |
| Web egress allow-list | `allowed_web_domains` + [src/lib/url-allowlist.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/url-allowlist.ts) | When `allow_web` is on, `WebFetch` is gated to approved hosts. Look-alike / IDN-homograph domains, loopback, and non-`http(s)` URLs are rejected. |
| Sender allow-lists (per channel) | `allowed_jids` / `allowed_telegram_chats` / `allowed_slack_users` | Drops inbound messages from anyone not listed before they reach the agent. |
| Sensitive-path guard | [src/lib/sensitive-paths.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/sensitive-paths.ts) | `.env`, `data/secrets`, `data/config.json`, `data/whatsapp-auth`, `data/marsclaw.db`, `~/.claude.json`, `~/.gemini` blocked from FS tools and `send_file` regardless of `allowed_paths`. |
| Grep/Glob recursion gate | [src/lib/tool-permissions.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/tool-permissions.ts) | Recursive tools refuse a search root that contains any sensitive subtree; bare `Grep`/`Glob` no longer silently scans cwd. |
| Mutation gate | [src/lib/mutation-gate.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/mutation-gate.ts), [approval-gate.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/approval-gate.ts) | `gmail_send`, `sheets_write`, `calendar_create_event`, write-style `*_raw` calls refuse unless `allow_mutating_tools` is set, or wait for a per-call `ok-XXXXXX` reply when `mutation_approval: "all"`. |
| Researcher subagent | `agents.researcher` in [src/providers/claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts) | The persona tells the agent to delegate page reads to a `tools: ['WebFetch']`-only subagent with "treat fetched content as untrusted" framing. (Instruction-level, not enforced: the main agent keeps `WebFetch` too when `allow_web` is on.) |
| Audit log | [src/lib/audit-log.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/audit-log.ts) | Append-only JSON-lines record of every tool decision at `logs/audit.log`. |
| MCP child env passthrough | `MCP_ENV_PASSTHROUGH` in [src/providers/claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts) | The stdio MCP server (the broker) gets an allow-listed env — no `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` or channel tokens. |
| Per-thread serialization | [src/index.ts](https://github.com/deBilla/marsclaw/blob/main/src/index.ts) `inFlight` map | Two messages in same chat never run two agent calls in parallel. |
| Startup circuit breaker | [src/lib/circuit-breaker.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/circuit-breaker.ts) | Sleeps progressively before boot if recent restarts have been suspiciously frequent — prevents crash loops from burning API quota. |
| Inbound rate-limit | [src/lib/rate-limit.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/rate-limit.ts) | Per-sender sliding windows (`rate_limit_per_minute`, `rate_limit_per_hour`); excess messages are dropped silently. |
| Cost cap | [src/lib/cost-tracker.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/cost-tracker.ts) | Refuses new turns once today's spend exceeds `daily_usd_budget` (metered Anthropic only). |
| Outbox attempt cap | [src/db/outbox.ts](https://github.com/deBilla/marsclaw/blob/main/src/db/outbox.ts) | Permanently fails delivery after `MAX_ATTEMPTS` (3); visible in logs. |
| Attachment safety | [src/lib/attachment-safety.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/attachment-safety.ts) + channel adapters | Rejects path-traversal filenames; adapters cap inbound media at 25 MB. |
| Backups | [src/lib/backup.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/backup.ts) | Daily DB + memory + WhatsApp auth snapshot. |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| WhatsApp cycling `code=405/428` | Outdated Baileys protocol | `bun update baileys` |
| Connected but no replies | WhatsApp replaying history (`type: append`) | Wait, then send a fresh message |
| `turn timed out` / `sweep: killing session …` | Long tool loop / network | Bump `MARSCLAW_AGENT_TIMEOUT_MS` |
| "I've hit my daily Gemini quota" | OAuth free tier hit | `bun run provider claude` and restart |
| Provider switch didn't take effect | Provider is resolved at boot | Restart the bot / `bun run service restart` |
| Reply duplicated 2-3× | Outbox drain-race (fixed in current `src/index.ts`) | Pull latest, restart |
| Voice notes ignored | Voice disabled | `bun run voice start` + `MARSCLAW_VOICE=1`, restart |
| `transcribe failed` | Whisper sidecar down | `bun run voice status` |
| `kokoro sidecar` error in speak | Kokoro sidecar down | `bun run voice start` |
| `Outside allowed_paths` | Agent tried to touch a path you didn't allowlist | `bun run path add <dir>` |
| `holds secrets or marsClaw's own permission config` | Agent tried to read `.env`, `data/secrets`, or similar | By design — secrets aren't reachable. See [security.md](security.md). |
| `Search root … contains sensitive files` | `Grep`/`Glob` was pointed at a root that straddles `.env` etc. | Narrow the search to a subdir (e.g. `src/`) |
| `Shell/Bash is disabled` | Agent tried to run a shell command | Set `allow_shell: true` in `data/config.json` only if you accept the exfil-risk trade-off |
| `Fetch denied: host … not on the allowlist` | `WebFetch` URL's host isn't in `allowed_web_domains` | Add the domain to `data/config.json` and restart; see [security.md](security.md) |
| `WebFetch is disabled` / `WebSearch is disabled` | `allow_web` is `false` | Set `allow_web: true` *and* populate `allowed_web_domains` |
| `Refused: "gmail_send" … disabled by default` | Mutating MCP tool blocked | Set `allow_mutating_tools: true` if you really want the bot to act outwardly |
| Telegram / Slack messages ignored | Sender not on `allowed_telegram_chats` / `allowed_slack_users`, or rate-limited | Copy the chat / user id from the warn log into `data/config.json` and restart |
| "I've hit today's spending cap" | Anthropic spend cap hit (`ANTHROPIC_API_KEY` only) | Wait for the UTC day to roll over, or bump `daily_usd_budget` |
| `whatsapp giving up after 5 failed connection attempts` | Too many linked devices, or geo block | Unlink, try another network |
| Bot sleeps for minutes on start | Circuit breaker after repeated crashes | Fix the crash (see `crashes/`); a clean shutdown resets it, or delete `data/circuit-breaker.json` |
| `Refusing to start: data/config.json is not valid JSON` | Torn or hand-edited config | Fix the JSON or delete the file |
| Service won't load | Plist references stale `bun` path | `bun run service install` to re-render |
