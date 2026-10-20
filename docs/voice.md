# Voice

WhatsApp and Telegram voice notes get transcribed; the Claude agent can reply in synthesized speech. Both directions run locally — no cloud, no Docker.

## Stack

Two Python sidecars on localhost:

| Sidecar  | Engine                            | Port  | Endpoint                          |
|---|---|---|---|
| Whisper  | `faster-whisper`                  | 9000  | `POST /transcribe`                |
| Kokoro   | `kokoro-onnx` (OpenAI-compatible) | 9001  | `POST /v1/audio/speech`           |

Source: [tools/whisper-server.py](https://github.com/deBilla/marsclaw/blob/main/tools/whisper-server.py), [tools/kokoro-server.py](https://github.com/deBilla/marsclaw/blob/main/tools/kokoro-server.py). Both share one venv under `tools/voice-env/`.

## Install

```bash
bun run voice install                    # runs tools/setup-voice.sh
```

The installer needs Python **3.11 or 3.12** and `ffmpeg`; if they're missing it installs them (Homebrew on macOS — elsewhere install them yourself, e.g. `sudo apt install python3.12 python3.12-venv ffmpeg`). It creates `tools/voice-env/`, installs faster-whisper + kokoro-onnx, downloads the Kokoro model (~325 MB) + voices file, and pre-caches the Whisper model.

Setup offers this for you if you answer `y` to *"Enable voice?"*, and starts the sidecars afterwards.

## Run

```bash
bun run voice start         # detached; PIDs in data/voice-*.pid, logs in data/voice-*.log
bun run voice status        # pid + health per sidecar
bun run voice restart
bun run voice stop
```

Then enable it for the bot:

```env
MARSCLAW_VOICE=1
```

…or set `voice_enabled: true` in `data/config.json`. Restart the bot.

## Sending a voice note

From WhatsApp or Telegram, send a voice message. In the log you should see a `… transcribed audio` line with a preview of the text, then a `claude turn end` with `chars: 0` (the reply went out via `speak`, so the text reply is empty and skipped).

## How it works

### Inbound (STT)

1. The WhatsApp adapter detects `audioMessage`; the Telegram adapter detects `voice` or `audio` (25 MB cap).
2. Downloads the blob, POSTs it as multipart to `http://127.0.0.1:9000/transcribe`.
3. Adds `[Voice]: <transcript>` alongside any text caption. If transcription fails, the agent gets `(voice message — transcription failed; ask the user to type)` instead.
4. From the agent's perspective it's just text.

Slack voice clips are not transcribed.

### Outbound (TTS)

1. The agent calls the `speak({ text, voice? })` MCP tool. ([src/mcp/speak.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/speak.ts))
2. The tool POSTs to `http://127.0.0.1:9001/v1/audio/speech` (OpenAI-shaped) with the configured voice.
3. Writes the returned audio to `data/voice-out/<id>.ogg` (`.mp3` when `KOKORO_FORMAT=mp3`).
4. Inserts an `outbox` row with `audio_path` set.
5. The drain loop calls `router.send(threadId, text, { audioPath })`. WhatsApp sends it as a voice-note bubble (`ptt: true`) when it's ogg/opus, otherwise as an audio attachment; Telegram uses `sendVoice`; Slack sends the text instead.

The persona ([CLAUDE.md](https://github.com/deBilla/marsclaw/blob/main/CLAUDE.md)) tells the agent to call `speak` whenever the user's message starts with `[Voice]:`, produce an empty text reply in that case, and keep the speech short. `GEMINI.md` carries the same instruction, but the Gemini provider has no tools, so on Gemini voice notes get a text reply.

## Voices

The default voice is `af_heart`. Override globally in `.env`:

```env
KOKORO_VOICE=af_bella
```

Or per-call by passing `voice` to the `speak` tool. Built-in voices:

| Name        | Locale | Notes                |
|---|---|---|
| `af_heart`  | en-US  | Warm, default         |
| `af_bella`  | en-US  | Bright, expressive    |
| `af_nicole` | en-US  | Neutral newsreader    |
| `am_adam`   | en-US  | Male, conversational  |
| `am_michael`| en-US  | Male, deeper          |
| `bf_emma`   | en-GB  | British female        |
| `bm_george` | en-GB  | British male          |

## Audio format

```env
KOKORO_FORMAT=ogg   # default — sent as a true WhatsApp voice note
KOKORO_FORMAT=mp3   # sent as audio attachment
```

Only `ogg/opus` renders as a proper voice-note bubble in WhatsApp. The Kokoro sidecar also accepts `wav`, but the `speak` tool currently saves anything that isn't `mp3` with an `.ogg` extension, so `wav` output is mislabelled — stick to `ogg` or `mp3`.

## Model sizes

Whisper defaults to `base` (~150MB, good English + accents):

```env
WHISPER_MODEL=tiny     # ~75MB, fastest, less accurate
WHISPER_MODEL=base     # ~150MB (default)
WHISPER_MODEL=small    # ~500MB, better accuracy
WHISPER_MODEL=medium   # ~1.5GB
WHISPER_MODEL=large    # ~3GB
```

`WHISPER_MODEL` is read by the installer and the Whisper sidecar (which inherits the environment of `bun run voice start`). Re-run `WHISPER_MODEL=small bun run voice install` after changing — the new model needs to download — then restart the sidecars with the same variable set.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Voice note ignored; debug log `audio received but voice disabled` | Voice not enabled | `MARSCLAW_VOICE=1` (or `voice_enabled: true`), restart, `bun run voice start` |
| `whatsapp transcribe failed` / `telegram transcribe failed` | Whisper sidecar down or unhealthy | `bun run voice status`; `bun run voice restart` |
| `Speech synthesis failed: … kokoro sidecar` | Kokoro sidecar down | `bun run voice start` |
| Voice replies arriving as plain text | Slack (no audio upload), or the provider is Gemini (no tools) | Use WhatsApp/Telegram with Claude |
| Voice reply arrives as an audio file, not a bubble | `KOKORO_FORMAT` is not `ogg` | Set `KOKORO_FORMAT=ogg` |
| First voice request is slow (~5s) | Model lazy-load on the sidecar | Subsequent calls are fast; ignore |
