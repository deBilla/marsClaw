# marsClaw

A personal chat agent — nothing more.

marsClaw is a single-process Bun app that connects messaging channels (Telegram, Slack, WhatsApp) to an LLM agent SDK (Gemini or Claude). Conversations land in SQLite; the chosen agent SDK handles the LLM call, tool use, and reasoning loop.

```
  ╲              ╱    marsClaw  ·  running
  │    ▄██▄     │
  │    ██████   │
  │    ▀██▀     │
  ╱              ╲    provider: claude  ·  channels: whatsapp, telegram
```

## Why it's small

The whole codebase is ~11k lines of TypeScript (~10.7k in `src/`). The hardest parts of building an agent — the reasoning loop, context compaction, the built-in tools (shell, read/write/edit, glob, grep, web fetch/search), model selection, retry logic — are delegated to the Claude Agent SDK or the Gemini CLI core. We own the chat-side glue: channel adapters, SQLite, an MCP server with channel-specific tools (`send_message`, `send_file`, `speak`, `youtube_transcript`, Gmail/Calendar/Drive/…), the security gates, and a little context engineering.

When Anthropic or Google ship a better model or improved tool use, we get it for free. Tradeoff: we're coupled to two specific SDK shapes. By default the agent runs in-process as the host user, secured by capability removal (no shell/web/mutations until you opt in); an optional **container runtime** runs it isolated instead, trading those capability gates for an isolation boundary — full shell and raw web inside a box that can't reach host secrets. See [docs/container-runtime.md](docs/container-runtime.md).

For a deeper comparison with the multi-tenant cousin, see [docs/vs-nanoclaw.md](docs/vs-nanoclaw.md).

## Highlights

- **Two agent SDKs, one wire format.** Pick Gemini or Claude. Switch any time with `bun run provider`. Automatic Claude→Gemini failover when Claude is over-quota.
- **Multi-channel.** Telegram, Slack (Socket Mode), WhatsApp (Baileys, QR auth). Enable any combination.
- **Voice in and out.** WhatsApp and Telegram voice notes are transcribed locally (faster-whisper); replies can be spoken locally (kokoro-onnx) and arrive as voice notes on WhatsApp and Telegram. No cloud, no Docker.
- **Report bugs from chat.** Tell it what went wrong (or what you wish it did) and it drafts a GitHub issue from the repo's own templates, scrubs anything private, and posts it after you approve. See [docs/github-issues.md](docs/github-issues.md).
- **YouTube transcripts.** Send a link, get a summary — the bot fetches captions via `yt-dlp` and the agent summarises in its reply.
- **Images & files.** WhatsApp images/documents and Slack file uploads are downloaded and passed to the agent as `@<path>` references. The agent can deliver files back via the `send_file` MCP tool (rendered as attachments on WhatsApp; Telegram and Slack currently receive only the caption text).
- **Google built-in.** OAuth-once, multiple Google accounts, MCP tools for Gmail, Calendar, Contacts, Drive, Sheets, Docs, Slides.
- **Persistent memory.** `MEMORY.md` is the agent's own long-term notebook. An optional, gitignored `wiki/` folder holds longer structured pages.
- **Hardened defaults.** No shell, no web egress, no outbound/mutating Google calls until you opt in — a fresh install has no third-party exfiltration channel. Per-channel sender allow-lists; sensitive paths (`.env`, secrets, config, provider creds) off-limits regardless of `allowed_paths`; `Grep`/`Glob` recursion gate; web reads delegated to a researcher subagent gated by an URL allow-list. Every tool decision lands in an append-only audit log, and a burst of denials pings you in chat. Optional per-call approval for Google writes. See [docs/security.md](docs/security.md).
- **Two runtimes: capability removal or isolation.** Run the agent in-process (the default, hardened as above) or flip to an isolated **container runtime** where the box is the boundary — full shell and raw web, but `.env`/DB/creds are never mounted and the real Anthropic credential lives in a host-side proxy. Toggle with `bun run container enable`. See [docs/container-runtime.md](docs/container-runtime.md).
- **One-shot setup.** `bash setup.sh` walks you from a fresh checkout to a running bot in ~2 minutes.

## Quick start

```bash
git clone <your-fork-url> marsclaw
cd marsclaw
bash setup.sh
```

Setup walks you through name/timezone/location, provider (Gemini or Claude), one-time browser login (auto-detected and skipped if already authed), channel selection, and WhatsApp linking. At the end it offers to start the bot for you.

To start it later:

```bash
bun run start
```

## Commands

```bash
bun run setup                       # rerun setup (idempotent)
bun run start                       # start the bot
bun run status                      # provider, db stats, recent threads
bun run provider [gemini|claude]    # switch agent provider
bun run whatsapp <sub>              # reset | status | clear-media
bun run slack <sub>                 # connect | status | disconnect
bun run container <sub>             # enable | disable | login | status
bun run voice <sub>                 # install | start | stop | restart | status
bun run google <sub>                # login | list | use | status | logout | test
bun run service <sub>               # launchd: install | uninstall | start | stop | restart | status | logs
bun run path <sub>                  # list | add <p> | remove <p> | reset
bun run usage <sub>                 # Anthropic spend (today | week | by-thread)
bun run backup                      # one-shot backup
bun run db <sub>                    # stats | vacuum | integrity
bun run update [--force]            # backup, pull, install, restart service
bun run smoke [prompt]              # fire a synthetic message end-to-end
```

## Documentation

Browse the docs site at **<https://deBilla.github.io/marsClaw/>** — or read the markdown directly in [docs/](docs/):

- [docs/architecture.md](docs/architecture.md) — message flow, components, SQLite schema, per-thread serialization
- [docs/configuration.md](docs/configuration.md) — `.env` and `data/config.json` reference, precedence rules
- [docs/channels.md](docs/channels.md) — per-channel setup: Telegram, Slack, WhatsApp
- [docs/providers.md](docs/providers.md) — Gemini vs Claude, switching, auth, costs, failover
- [docs/voice.md](docs/voice.md) — Whisper STT + Kokoro TTS sidecars, voices, model sizes
- [docs/youtube.md](docs/youtube.md) — YouTube transcript MCP tool, yt-dlp dependency, auto-summarise behaviour
- [docs/google.md](docs/google.md) — Google OAuth (Gmail/Calendar/Drive/Sheets/Docs/Slides/Contacts)
- [docs/operations.md](docs/operations.md) — running as a launchd service, backups, observability, troubleshooting
- [docs/security.md](docs/security.md) — threat model, capability flags, audit log, residual risks
- [docs/container-runtime.md](docs/container-runtime.md) — isolated container mode: host/sidecar split, credential proxy, what's mounted, security trade
- [docs/development.md](docs/development.md) — codebase tour, adding a channel, adding an MCP tool, tests
- [docs/vs-nanoclaw.md](docs/vs-nanoclaw.md) — when to pick marsClaw vs the multi-tenant cousin

## Requirements

- macOS or Linux (or WSL). Setup auto-installs nvm (SHA-256-verified), Node (pinned `22.18.0`), and Bun (pinned `1.3.14`) — no prerequisites beyond `curl` and `bash`. The `service` command (launchd) is macOS-only; on Linux run `bun run start` under your own supervisor.
- A bot/app token from each channel you want to enable.
- **Voice (optional):** Python 3.11 or 3.12 and `ffmpeg`. `bun run voice install` installs them for you if missing (Homebrew on macOS).
- **YouTube transcripts (optional):** `yt-dlp`. Setup will offer to install it via `brew` or `pip` and pin its path into `.env`.
- **Container runtime (optional):** a container daemon + the open-source `docker` CLI. The target is [Colima](https://github.com/abiosoft/colima) (free; not OrbStack/Docker Desktop). See [docs/container-runtime.md](docs/container-runtime.md).

## Privacy

These never leave your machine and are all gitignored:

- `.env` — channel tokens, API keys
- `data/` — SQLite DB, WhatsApp linked-device auth, downloaded media, usage ledger, backups
- `logs/`, `conversations/`, `crashes/` — app + audit logs, archived transcripts, crash dumps
- `MEMORY.md`, `wiki/` — anything the agent has noted about you

The agent SDK's own credentials live in your home directory (`~/.gemini/`, `~/.claude.json`), not in this repo. Google OAuth refresh tokens are stored in the macOS Keychain (or 0600 files under `data/secrets/` on Linux), never in `.env`.

## License

MIT.
