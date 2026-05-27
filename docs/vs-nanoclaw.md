# marsClaw vs NanoClaw — thorough comparison

Both projects build personal-chat agents on top of large language models. They make very different tradeoffs. This doc walks the axes one at a time so you can pick the right one for the situation.

[NanoClaw](https://github.com/qwibitai/nanoclaw) is the upstream multi-tenant agent platform. marsClaw is a personal-scale rewrite that runs an off-the-shelf agent SDK **in-process** (the Claude Agent SDK or the Gemini CLI core) instead of orchestrating per-session containers.

> Earlier versions of this doc described marsClaw as a thin wrapper that shelled out to a CLI once per message. That's no longer accurate: marsClaw now embeds the agent SDK as a library, keeps one long-lived session per chat thread, and has grown a Google Workspace tool suite, a service installer, backups, budgeting, and conversation archiving. The sections below reflect the current code.

## At-a-glance

| | marsClaw | NanoClaw |
|---|---|---|
| Code size | ~7k lines of TS (`src/`) | dramatically larger (host + container-runner + skills + tests) |
| Target user | one person on their laptop | one host serving many people, multi-tenant |
| Isolation | none — agent runs as the host user (sandboxed to an `allowed_paths` allowlist) | per-session Docker / Apple Container |
| Agent runtime | Claude Agent SDK **or** Gemini CLI core, in-process; one long-lived session per thread | Claude Agent SDK in-container; OpenCode via providers branch |
| State store | one SQLite file | central DB + per-session inbound.db + outbound.db |
| Credentials | `.env` + macOS Keychain (Google OAuth) | OneCLI credential vault with approval flows |
| Setup | one interactive `setup.sh`, ~2 min | multi-step (OneCLI, container build, mounts, service install) |
| Channels shipped | Telegram, Slack, WhatsApp baked in | ~15 adapters, installed via `/add-<name>` skills |
| Self-modification | none | `install_packages`, `add_mcp_server` (admin-approved) |
| Provider switch | `bun run provider <name>` — 1 command, plus auto Claude→Gemini failover | per-group `agent_provider` field; lives in central DB |
| Service install | `bun run service install` (launchd) | launchd/systemd via setup |
| Built-in integrations | Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts) | provider/skill dependent |

---

## Architecture

| | Pros | Cons |
|---|---|---|
| **marsClaw** — single Bun process; the agent SDK runs in-process with one long-lived session per thread (LRU-capped at `max_sessions`, idle/age-swept) | Trivial to debug; one process to inspect; no IPC, no Docker; cold-start (~10s SDK/googleapis import) paid once per chat, not per message; sessions resume from the on-disk transcript after a recycle or crash | One crash kills everything; agent shares the host fs (mitigated, not eliminated, by `allowed_paths`); no per-conversation isolation |
| **NanoClaw** — host orchestrates per-session containers; two SQLite DBs per session as the only IO surface | Strong fault isolation (container crash ≠ host crash); concurrent sessions don't interfere; cross-mount DB pattern is well-tested | Two-DB design is genuinely tricky (the `journal_mode=DELETE` invariant, the seq parity rule, the heartbeat file); container build cache staleness is real; debugging a stuck session means correlating files across mounts |

Note the runtime mechanism is no longer the dividing line — both sides now embed the Claude Agent SDK. The real difference is *where* it runs: marsClaw in the host Bun process, NanoClaw in a per-session container.

## Isolation & security

| | Pros | Cons |
|---|---|---|
| **marsClaw** | **In-process action broker:** the MCP server is the sole egress path and the only process that holds Google creds (Anthropic key withheld from it by env passthrough). **Default-deny capability flags:** `allow_shell`, `allow_web`, `allow_mutating_tools` are all off out-of-the-box — fresh install has no third-party exfil channel. **Sensitive-path guard** blocks `.env`, `data/secrets`, `data/config.json`, `data/whatsapp-auth`, `data/marsclaw.db`, `~/.claude.json`, `~/.gemini` from FS tools *regardless* of `allowed_paths`; `Grep`/`Glob` recursion gate refuses search roots that straddle them. **Web allow-list + researcher subagent:** web reads delegated to a `tools:['WebFetch']`-only subagent in an empty-room context, gated to approved hosts. **Per-channel sender allow-lists** (Telegram chat ids, Slack user ids, WhatsApp JIDs). **Append-only audit log** of every tool decision at `logs/audit.log`. Plus the existing rate-limits, budget cap, per-thread serialization, backups. See [security.md](security.md). | Still no container — enforcement is process-boundary + policy, not kernel; a malicious dependency or a re-enabled shell bypasses the in-process gates; channel tokens sit in `.env` on disk; the audit log is local-only (no remote sink) |
| **NanoClaw** | Containerized agent; OneCLI mediates all credentialed calls (secrets never enter the agent's context); approval flows route to scoped admins → global admins → owners | OneCLI adds a long-poll loop you have to keep alive; "selective" secret mode default catches every new operator; cross-container session sharing requires extra care |

## Entity model & multi-user

| | Pros | Cons |
|---|---|---|
| **marsClaw** | `(channel_prefix:thread_id)` is the entire identity model — 0 abstractions to learn; per-channel sender allow-lists (`allowed_telegram_chats`, `allowed_slack_users`, `allowed_jids`) drop unauthorised senders before the agent loop | Single trust tier — anyone on the allow-list is "owner"; no per-user scopes, no "admin" concept |
| **NanoClaw** | Real users with roles (owner / admin scoped or global); per-agent-group membership; three isolation levels (agent-shared, shared, separate agents); cold-DM resolution with `user_dms` cache | The wiring matrix (users × agent_groups × messaging_groups × sessions) is a real learning curve; for a single user it's pure overhead |

## Channels

| | Pros | Cons |
|---|---|---|
| **marsClaw** | Three adapters shipped (Telegram, Slack Socket Mode, WhatsApp/Baileys with QR auth), lazy-loaded so unused ones cost nothing; adding a channel = write a new file matching the `Channel` interface (~60 lines) | Only 3 channels right now; iMessage, Discord, Linear, GitHub etc. would all need writing |
| **NanoClaw** | 15+ channels including Discord, Teams, Linear, GitHub, iMessage (local + remote), Webex, Matrix, WeChat, DeltaChat, Emacs, X, Slack, Telegram, both WhatsApp variants | Each channel skill is a separate install step; the skills/branches model means channel code isn't on trunk — `git clone` doesn't get you the adapter you want |

## Voice (STT / TTS)

Conceptually identical architecture: local sidecars for Whisper and Kokoro.

| | Pros | Cons |
|---|---|---|
| **marsClaw** | Python venv, no Docker; one `bun run voice install`; faster-whisper for STT and kokoro-onnx for TTS, both fully local | Two Python services to babysit; ffmpeg + Python 3.10+ prereqs; ~650MB models on disk |
| **NanoClaw (nanoclaw-voice)** | `docker compose up -d` and you're done; sidecars auto-restart with the rest of the stack | Requires Docker; first-time image pull is slow; can't run in environments where Docker is blocked |

## Tools available to the agent

| | Pros | Cons |
|---|---|---|
| **marsClaw** | Whatever the chosen SDK ships (read, write, edit, glob, grep — shell and web are off by default, see [security.md](security.md)) **plus** our own MCP suite: `send_message`, `send_file`, `speak`, and a full Google Workspace set — Gmail (search/read/send), Calendar, Drive, Docs, Sheets (read/write), Slides, Contacts, with multi-account support. A `researcher` subagent (`tools:['WebFetch']`, empty-room context) handles web reads when enabled. | Bound by what the Claude Agent SDK / Gemini core expose for the core loop; no scheduling, no built-in image gen / LaTeX |
| **NanoClaw** | Rich custom MCP suite: `send_message`, `send_file`, `edit_message`, `schedule_task`, `ask_user_question`, `install_packages`, `add_mcp_server`, sub-`agents` spawn, `voice`, `latex`, `imagegen`, `interactive` | More to maintain; tool bugs are yours to fix; each tool's deps go into the container image |

## Memory & skills

| | Pros | Cons |
|---|---|---|
| **marsClaw** | Per-provider persona file (`CLAUDE.md` / `GEMINI.md`), one `MEMORY.md` the agent edits, a `wiki/` folder for longer structured pages, `skills/*.md` referenced via `@skills/...`, and **automatic conversation archiving** on session recycle/compaction (`conversation-archive`) | No per-conversation persona variants; if `MEMORY.md` grows huge the agent has to consolidate it itself (the persona instructs it to) |
| **NanoClaw** | Per-agent-group `CLAUDE.md` + `CLAUDE.local.md`; agent owns a workspace and a `conversations/` archive (auto-created by PreCompact hook); skill ecosystem with 4 distinct skill types | Lots of context files to keep in sync; "where does this instruction live" is a real question |

## Self-modification

| | Pros | Cons |
|---|---|---|
| **marsClaw** | None — restart loop is trivial because there's nothing to mutate; `bun run update` pulls + reinstalls + restarts the service | Want a new tool? Stop the bot, write code, restart. Can't say "agent, install pandas" |
| **NanoClaw** | `install_packages` (apt/npm) and `add_mcp_server` work end-to-end with admin approval, image rebuild, container restart; planned source-edit draft/activate flow | Significant infrastructure (approval primitives, image rebuild logic, restart orchestration); approval delivery has many subtle paths |

## Setup & onboarding

| | Pros | Cons |
|---|---|---|
| **marsClaw** | `bash setup.sh` → interactive — name/timezone/location, provider, login (auto-detected/skipped if already authed), channels, WhatsApp linking, voice, all in one flow; clones to a working bot in ~2 min; `bun run service install` registers a launchd service; `bun run update` handles upgrade + restart; SQLite migrations run automatically | Still macOS/Linux-focused; no per-machine config layering; launchd installer is macOS-first |
| **NanoClaw** | Setup walks operator through host install, OneCLI vault, container image build, mount allowlist, service installation (launchd/systemd), first-agent bootstrap; migration script for v1 → v2 | Lots of steps; lots of places it can wedge; full setup feels heavy if you just want to chat with a bot |

## Observability

| | Pros | Cons |
|---|---|---|
| **marsClaw** | Structured `pino` logging with rotation (`log-rotate`); `bun run status` for db summary; `bun run usage` for Anthropic spend (today / week / by-thread); per-thread heartbeat (drives the live "typing…" indicator and stuck-turn detection); a health server; `bun run service logs` | Sidecar (voice) logs are separate; with no service installed, logs follow your terminal unless you redirect |
| **NanoClaw** | Structured logs: `nanoclaw.log`, `nanoclaw.error.log`, `setup-steps/*.log`; session DBs as inspectable forensic artifacts; container heartbeat, pending_questions, processing_ack tables | Container logs are ephemeral (`--rm` flag) — silent failures inside the container leave nothing behind; correlating an issue across host + container is multi-step |

## Performance

| | Pros | Cons |
|---|---|---|
| **marsClaw** | Sessions stay warm between turns (one long-lived SDK `query()` per thread); cold start (~10s) paid once per chat, not per message; idle/old sessions swept and the live set is LRU-capped at `max_sessions`, so a flood of new threads can't OOM the host; in-flight turns can be interrupted by a new message | First message of a new thread pays the SDK/googleapis import cost; many simultaneously-active threads each hold a warm session in memory |
| **NanoClaw** | Sessions stay warm between turns; idle containers killed by sweep; fast on burst usage; gentle on the rate limiter | First message of a new session is slow (container boot); more memory at idle if you have many active sessions |

The per-message cold-start penalty that used to be marsClaw's headline weakness is gone — both sides now keep sessions warm and cap/sweep the idle set.

## Provider portability

| | Pros | Cons |
|---|---|---|
| **marsClaw** | Two providers ship by default (Claude Agent SDK, Gemini CLI core); runtime switch with `bun run provider`; automatic Claude→Gemini failover on hard errors (quota/auth) so a single turn still gets answered | Bound to the two SDK shapes we wrap; adding a third means learning that SDK's event/result surface |
| **NanoClaw** | Provider abstraction in `container/agent-runner/src/providers/`; per-agent-group provider; richer event translation between SDK events and host loop | Adding a new provider means understanding the full event protocol (init, result, retry, rate_limit, compact_boundary, task_notification, etc.) |

## Failure modes seen in practice

| Failure | marsClaw | NanoClaw |
|---|---|---|
| Claude quota exhausted | Automatic failover to Gemini for that turn (if Gemini is authed); otherwise a friendly reply + log | Per-agent-group provider; quota is in OneCLI's domain |
| Gemini quota exhausted | Friendly reply + log; switch with `bun run provider claude` | Per-agent-group provider; quota is in OneCLI's domain |
| Daily spend cap hit | `cost-tracker` blocks the turn with a budget message (metered API only; skipped under Pro/Max OAuth) | Budgeting is in OneCLI's domain |
| WhatsApp Baileys protocol drift | Bump `baileys` in `package.json`, `bun run update` | Same Baileys, but inside container — need to rebuild image |
| Agent process hangs mid-message | 300s timeout in `agent.ts` (override via `MARSCLAW_AGENT_TIMEOUT_MS`); heartbeat stops the typing indicator; visible in logs | 60s sweep loop detects stuck container; declared-timeout hooks adjust tolerance |
| Two messages to same thread arrive at once | Per-thread serialization; a newer message can interrupt the in-flight turn | Same idea, but at session-DB level (one writer per file) |
| Repeated startup crash | `circuit-breaker` backs off restarts instead of hot-looping | Container restart policy |

---

## When to pick which

**Pick marsClaw if:**

- It's just you (or a trusted handful), on your machine, talking to your own bot
- You'd rather read the entire codebase in one sitting than learn a domain model
- Docker isn't available or wanted (locked-down work laptop, restricted environment)
- You want to swap between Claude and Gemini without touching code, with automatic failover
- You want Gmail / Calendar / Drive / Docs / Sheets / Slides / Contacts wired in out of the box
- You're learning what a personal-chat-agent architecture looks like before committing
- You believe in delegating the hard parts (agent loop, tool plumbing) to Anthropic / Google

**Pick NanoClaw if:**

- More than a handful of people use the bot, and they don't all trust each other
- You need per-user / per-group workspace isolation in containers
- You need approval workflows around credentialed actions
- You want agents to install their own deps / extend themselves at runtime
- You want 15+ channel adapters available without coding
- You're deploying somewhere shared, not a personal laptop
- You're willing to invest in learning a richer model in exchange for production-grade primitives

---

## The honest summary

They're still not really competitors. NanoClaw is a multi-tenant agent platform; marsClaw is a personal-scale one.

What's changed is that the *runtime* distinction has mostly collapsed: marsClaw used to shell out to a CLI per message, but it now embeds the same Claude Agent SDK NanoClaw uses, keeps warm sessions, and has grown real operational machinery (service install, backups, budgeting, archiving, observability). The remaining difference is structural, not mechanical — NanoClaw runs each session in its own container with users, roles, and approval flows; marsClaw runs everything in one host process for one owner, sandboxed to an `allowed_paths` allowlist rather than a container.

You'd use NanoClaw for a team or a product. You'd use marsClaw because it's Friday night and you want a Telegram bot — that can also read your inbox and speak — running by Sunday.
