# nothingClaw

A personal chat agent — nothing more.

nothingClaw is a single-process Bun app that connects messaging channels (Telegram, Slack, WhatsApp) to an agent CLI (Gemini CLI or Claude Code). Messages route through SQLite; the chosen agent CLI handles the LLM call, tools, and reasoning loop.

```
  ╲ ╲ ╲    nothingClaw  ·  running
   ╲ ╲ ╲   provider: gemini  ·  channels: telegram, whatsapp
```

## Features

- **Two agent CLIs, one wire format.** Pick Google's Gemini CLI or Anthropic's Claude Code. Switch any time with `bun run provider`.
- **Multi-channel.** Telegram, Slack (Socket Mode), WhatsApp (Baileys, QR auth). Enable any combination.
- **Image support.** WhatsApp images are downloaded and passed to the agent via `@<path>` for vision.
- **MCP tool — `send_message`.** For proactive / multi-part replies. Add more by dropping files into `src/mcp/`.
- **Per-thread serialization.** Two messages from the same chat can never race two agent subprocesses.
- **Auto-detected login.** If you've already authed `gemini` or `claude` in another terminal, setup skips the login step.
- **Persistent agent memory.** `MEMORY.md` is editable by the agent itself for long-term recall.

## Requirements

- macOS or Linux (or WSL). Setup auto-installs Bun.
- Node + npm (for installing the agent CLI globally).
- A bot/app token from each channel you want to enable.

## Quick start

```bash
git clone <your-fork-url> nothingclaw
cd nothingclaw
bash setup.sh
```

Setup walks you through:

1. **Pick an agent CLI.** Gemini CLI or Claude Code — auto-installs from npm if missing.
2. **One-time browser login.** Auto-detected and skipped if you're already authed.
3. **Connect channels.** Telegram, Slack, WhatsApp — any combination, all optional.

Then run the bot:

```bash
bun run start
```

For WhatsApp on first start, scan the QR code printed in the terminal:
**WhatsApp on phone → Settings → Linked devices → Link a device**.

## Commands

```bash
bun run setup                       # rerun setup (idempotent)
bun run start                       # start the bot
bun run status                      # provider, db stats, recent threads
bun run provider [gemini|claude]    # switch agent provider (interactive if no arg)
bun run whatsapp reset              # clear WhatsApp auth → forces a new QR
bun run whatsapp status             # show link state + cached media count
bun run whatsapp clear-media        # purge data/whatsapp-media/
```

## Architecture

```
┌───────────────────┐               ┌──────────────────────────┐
│  channel adapter  │ ── text ──▶   │  handleMessage           │
│  · telegram       │               │  · persist to sqlite     │
│  · slack          │               │  · build prompt          │
│  · whatsapp       │               │  · spawn gemini / claude │
└───────────────────┘               │  · send reply            │
        ▲                           └──────────────────────────┘
        │                                       │
        └─── router.send ◀── outbox drain ◀─────┘
```

Single process. SQLite (`data/nothingclaw.db`) is the only state:

- `messages` — conversation history per thread
- `outbox` — async messages queued by the agent's `send_message` MCP tool

The agent CLI runs as a subprocess per incoming message. Its built-in tools (shell, file read/write/edit, glob, grep, web fetch/search) plus our tiny MCP server give it everything it needs.

## Configuration (`.env`)

`setup` writes this for you; edit by hand to tweak.

| Key | Required | Notes |
|---|---|---|
| `AGENT_PROVIDER` | yes | `gemini` or `claude` |
| `TELEGRAM_BOT_TOKEN` | per-channel | From [@BotFather](https://t.me/BotFather) |
| `SLACK_BOT_TOKEN` | per-channel | `xoxb-…` |
| `SLACK_APP_TOKEN` | per-channel | `xapp-…` (needs `connections:write`) |
| `NOTHINGCLAW_WHATSAPP` | per-channel | Set to `1`; auth via QR on first start |
| `GEMINI_API_KEY` | optional | Use a paid key instead of OAuth (higher quota) |
| `NOTHINGCLAW_AGENT_TIMEOUT_MS` | optional | Per-message timeout (default `120000`) |
| `NOTHINGCLAW_WHATSAPP_VERBOSE` | optional | Set to `1` to dump Baileys protocol logs |

## Memory and skills

- `GEMINI.md` / `CLAUDE.md` — agent persona, behavior, tools. Edit either or both.
- `skills/*.md` — sub-instructions referenced via `@skills/<name>.md` from the persona file.
- `MEMORY.md` — the agent's own long-term memory. Local-only, **gitignored**. Seeded from `MEMORY.template.md` on first run.

To reset memory: `rm MEMORY.md && bun run start`.

## Privacy — what's gitignored

These never leave your machine:

- `.env` — all credentials (channel tokens, API keys)
- `data/` — SQLite db, WhatsApp linked-device auth, downloaded message media
- `MEMORY.md` — anything the agent has noted about you (people, preferences, projects)

The agent CLI's own credentials live in your home directory (`~/.gemini/`, `~/.claude.json`), not in this repo.

## Provider notes

**Gemini CLI** with OAuth (free tier): daily quota resets ~16–24h. When exhausted, the bot replies with a friendly note instead of going silent. Bypass with `GEMINI_API_KEY=…` or `bun run provider claude`.

**Claude Code**: invoked with `--dangerously-skip-permissions` because there's no human in the loop to approve tool calls.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| WhatsApp keeps cycling (`code=405/428`) | Outdated Baileys protocol | `bun update baileys` |
| Connected but no replies | Replaying history (`type: append`) — only `notify` is processed | Wait a few seconds, then send a fresh message |
| `[gemini] timeout after 120000ms` | Slow tool loop or quota retries | Bump `NOTHINGCLAW_AGENT_TIMEOUT_MS` or switch provider |
| `[whatsapp] skipped non-text (audioMessage)` | Audio not yet supported | Text + images only for now |
| `[whatsapp] giving up after 5 failed connection attempts` | Too many linked devices, or geo block | Unlink from phone, or try a different network |

For deeper debugging, set `NOTHINGCLAW_WHATSAPP_VERBOSE=1` to see Baileys protocol logs.

## License

MIT.
