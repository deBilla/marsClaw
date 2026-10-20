# Channels

marsClaw ships three messaging channels: Telegram, Slack, and WhatsApp. Each is optional; enable any combination. Adapters live in [src/channels/](https://github.com/deBilla/marsclaw/blob/main/src/channels/) and implement the `Channel` interface in [src/channels/types.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/types.ts).

```ts
interface Channel {
  send(threadId: string, text: string, opts?: SendOpts): Promise<void>;
  setTyping?(threadId: string): Promise<void>;
}
```

| Capability | Telegram | Slack | WhatsApp |
|---|---|---|---|
| Text in / out | ✓ (long replies split at 4000 chars) | ✓ | ✓ |
| Voice notes in (Whisper) | ✓ (voice + audio files) | — | ✓ |
| Voice replies out (`speak`) | ✓ (`sendVoice`) | text fallback | ✓ (ogg → voice-note bubble) |
| Images / documents in | — | ✓ (needs `files:read`) | ✓ |
| `send_file` out | caption text only | caption text only | ✓ (image / video / document) |
| Typing indicator | — | — | ✓ |
| `stop` interrupt, slash-command filter | — | — | ✓ |
| Sender allow-list + rate limit | ✓ | ✓ | ✓ |

Inbound attachments are saved under `data/shared/<channel>-media/` (capped at 25 MB) and handed to the agent as `[user attached an image: @<path>]` / `[user attached a document "<name>": @<path>]` markers. Untrusted filenames are sanitised before they touch disk ([src/lib/attachment-safety.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/attachment-safety.ts)).

Thread IDs are channel-prefixed (`telegram:`, `slack:`, `whatsapp:`); the [ChannelRouter](https://github.com/deBilla/marsclaw/blob/main/src/channels/router.ts) uses the prefix to dispatch outbound sends back to the right adapter.

## Telegram

The simplest channel to set up.

### First-time setup

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, follow the prompts. You'll get a token like `123456:ABC-DEF…`.
2. Run `bun run setup` and answer `y` to *"Enable Telegram?"*. Paste the token when prompted. Setup writes it to `.env` as `TELEGRAM_BOT_TOKEN=…` and offers to capture an optional chat-id allow-list (see below).
3. Restart the bot. Message your bot from Telegram.

Manual route, if you'd rather skip the wizard:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF…
```

Telegram supports text in/out and voice: voice notes and audio files are transcribed when voice is enabled (prefixed `[Voice]:`), and `speak` replies go out via `sendVoice`. No images or documents in, no file attachments out (a `send_file` delivers only its caption), and no typing indicator. Adapter: [src/channels/telegram.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/telegram.ts).

### Setup is idempotent

Re-running `bun run setup` picks up the existing `TELEGRAM_BOT_TOKEN` and offers `enter to keep current` when prompting for the token, so you only paste it once. The prompt also validates the shape (`<digits>:<base64-ish>`) and asks for confirmation if it looks wrong.

### Disabling without losing the token

Answer `n` to *"Enable Telegram?"* and setup **comments out** the token rather than deleting it:

```env
# TELEGRAM_BOT_TOKEN=123456:ABC-DEF…
```

The runtime keys off the presence of an uncommented token, so the channel goes dark — but you can re-enable later by uncommenting that line (or by re-running setup) without bothering @BotFather again.

### Allow-list

Telegram has no phone-based identity, so the only inbound gate is a chat-id allow-list. Setup will ask:

```
  Allowed chat ids (comma-separated): 123456789,987654321
```

Empty means accept any sender. Most owners don't know their chat id yet — while the list is empty the bot logs a `warn` with each sender's chat id, so the usual flow is: leave it empty initially, send a message to the bot from your phone, copy the chat id from the logs into `data/config.json`:

```jsonc
{
  "allowed_telegram_chats": ["123456789"]
}
```

or shadow it via `MARSCLAW_TELEGRAM_ALLOWED_CHATS=123456789` in `.env`. Rejected senders are logged at `warn` with the chat id.

## Slack

Uses Socket Mode — no public webhook needed.

**Recommended:** `bun run setup` (or `bun run slack connect` on an existing install) generates a personalised app manifest named after you, opens the Slack creation page pre-filled, then collects the two tokens and an optional user-id allow-list. `bun run slack status` shows the wiring; `bun run slack disconnect` comments the tokens out of `.env` (kept for re-enabling). Both restart the launchd service if one is installed.

Manual route, using [slack-manifest.yaml](https://github.com/deBilla/marsclaw/blob/main/slack-manifest.yaml):

1. [api.slack.com/apps?new_app=1](https://api.slack.com/apps?new_app=1) → **From a manifest** → paste the file → Create.
2. Bot scopes (already in the manifest): `chat:write`, `files:read`, `files:write`, `im:history`, `im:read`, `im:write`, `app_mentions:read`, `users:read`. `files:read` is required to download files users share — without it Slack returns an HTML login page and the bot logs a warning.
3. **Install App** → copy the Bot User OAuth Token (`xoxb-…`) → `SLACK_BOT_TOKEN`.
4. **Basic Information** → App-Level Tokens → "Generate Token and Scopes" with scope `connections:write` → `xapp-…` → `SLACK_APP_TOKEN`.
5. Socket Mode and the `message.im` / `app_mention` events are set by the manifest.
6. Restart the bot. DM the app from Slack.

What the adapter handles: DMs (plain messages and `file_share` uploads — images and documents are downloaded and passed to the agent) and `@mentions` in channels. Outbound is text only — `send_file` and `speak` fall back to their text. The thread id is the Slack channel/DM id (`slack:D…`), while the allow-list holds **user** ids (`U…`).

Adapter: [src/channels/slack.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/slack.ts). Lazy-loaded — non-Slack users don't pay the `@slack/bolt` import cost.

## WhatsApp

The richest channel: text, images (vision), voice notes in and out, document attachments both ways, typing indicator, and a `stop` interrupt. Uses [Baileys](https://github.com/WhiskeySockets/Baileys) — WhatsApp's web-multi-device protocol — so no Business API account needed.

### First-time link

Setup will walk you through this; the bot can be started inside the setup flow so the QR appears live. Manual route:

```env
MARSCLAW_WHATSAPP=1
```

Then `bun run start` and scan the QR with your phone:
**WhatsApp → Settings → Linked devices → Link a device**

Auth is saved to `data/whatsapp-auth/` (gitignored). Subsequent boots reconnect silently.

### Owner pairing

WhatsApp's `@lid` identifiers can differ from the phone-derived `@s.whatsapp.net` JID, so on a fresh link the bot can't tell which incoming JID is "you". Setup writes a one-shot pairing code into `data/config.json` with a **5-minute expiry** (`whatsapp_pair_expires_at`): send the printed code from your phone, the bot captures the real JID into `allowed_jids`, and the pairing state is cleared. Other messages are ignored while pairing is pending; if the window lapses, re-run setup.

### Allow-list

Set `allowed_jids` in `data/config.json` (or `MARSCLAW_WHATSAPP_ALLOWED_JIDS=…` in env) to restrict who can talk to the bot. Empty list = allow anyone. On boot the log will say which mode you're in:

```
WhatsApp allow-list active count=2
```

```
WhatsApp allow-list disabled — accepting from any sender. Set allowed_jids in data/config.json to restrict.
```

### Useful commands

```bash
bun run whatsapp status       # link state + cached media count
bun run whatsapp reset        # wipe auth → forces a new QR
bun run whatsapp clear-media  # purge cached media (see note)
```

> **Known mismatch:** `status` / `clear-media` look in `data/whatsapp-media/` (the old location), but the adapter now saves media to `data/shared/whatsapp-media/`. Until the CLI is updated, run `MARSCLAW_WHATSAPP_MEDIA=data/shared/whatsapp-media bun run whatsapp clear-media`.

### Images & documents

Inbound images and documents are downloaded to `data/shared/whatsapp-media/` (25 MB cap) and passed to the agent as `@<path>` markers so Claude can read them. Caption text (if any) accompanies the attachment. Outbound `send_file` sends images and videos inline and everything else as a document.

### Interrupt and slash commands

A message that is just `stop`, `abort`, `cancel`, `nvm`, `never mind` (trailing punctuation allowed) tears down the in-flight turn immediately instead of queueing behind it, and replies `Stopped.` or `Nothing in progress.`. Messages starting with an interactive-CLI command (`/help`, `/clear`, `/compact`, `/login`, …) are dropped silently ([src/lib/command-gate.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/command-gate.ts)).

### Voice

If voice is enabled (`MARSCLAW_VOICE=1` or `voice_enabled: true`) and the Whisper sidecar is running, inbound voice notes are transcribed and prepended with `[Voice]:` so the agent knows to reply via the `speak` MCP tool. Replies are sent as a voice-note bubble when `KOKORO_FORMAT=ogg`. See [voice.md](voice.md).

### Verbose protocol logs

```bash
MARSCLAW_WHATSAPP_VERBOSE=1 bun run start
```

Adapter: [src/channels/whatsapp.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/whatsapp.ts), pairing: [src/channels/whatsapp-link.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/whatsapp-link.ts).

## Adding a new channel

The minimal skeleton (real adapters add an allow-list, a rate limiter and media handling — copy [telegram.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/telegram.ts) as a starting point):

```ts
// src/channels/mychannel.ts
import type { Channel, ChannelInit } from './types.ts';

export function createMyChannel(opts: { token: string } & ChannelInit): Channel {
  // 1. connect to the upstream SDK
  // 2. on inbound message → opts.onMessage(`mychannel:${threadId}`, text)
  // 3. expose send(threadId, text, opts) — strip the `mychannel:` prefix
  return {
    async send(threadId, text, sendOpts) { /* ... */ },
    async setTyping(threadId) { /* optional */ },
  };
}
```

Then wire it up in [src/index.ts](https://github.com/deBilla/marsclaw/blob/main/src/index.ts) behind a feature flag with `router.register('mychannel', ch)` — the [router](https://github.com/deBilla/marsclaw/blob/main/src/channels/router.ts) dispatches outbound sends by that prefix.

## Failure modes

| Symptom | Channel | Fix |
|---|---|---|
| Connected but no replies | WhatsApp | Replaying history (`type: append`); only `notify` is processed. Send a fresh message. |
| `code=405/428` cycling | WhatsApp | Outdated Baileys protocol. `bun update baileys` |
| `whatsapp giving up after 5 failed connection attempts` | WhatsApp | Too many linked devices, or geo block. Unlink from phone, or try another network. |
| `data/whatsapp-needs-reauth` exists | WhatsApp | Linked device was logged out. `bun run whatsapp reset` and re-scan. |
| `Same reply 2-3 times` | any | Was a drain-race bug. Pull latest; restart. |
| `slack file download returned HTML` | Slack | Add `files:read`, reinstall the app (`bun run slack connect`). |
| `slack rejected — sender not in allow-list` | Slack | Add the logged user id to `allowed_slack_users`. |
| Telegram bot doesn't see DMs | Telegram | `/setprivacy` in BotFather to disable group-only privacy (irrelevant for DMs but a common red herring). |
