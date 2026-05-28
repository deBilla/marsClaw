# YouTube transcripts

Send the bot a YouTube link and it replies with a summary. The transcript is fetched locally, summarised by the running agent (Claude or Gemini), and never leaves your machine beyond the request to youtube.com.

## Stack

A single MCP tool, [src/mcp/youtube.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/youtube.ts), backed by [yt-dlp](https://github.com/yt-dlp/yt-dlp) for caption extraction. The agent itself does the summarisation, so no extra API key or provider-specific code is involved.

## Install

Setup will offer this for you on first run — answer `y` to *"Install yt-dlp now?"* and it shells out to `brew install yt-dlp` on macOS, falling back to `pip install --user yt-dlp` elsewhere. Manual route:

```bash
brew install yt-dlp                # macOS
# or: pipx install yt-dlp
# or: pip install --user yt-dlp

bun run setup                      # re-run setup to pin the path into .env
```

The MCP server runs as a launchd subprocess with a minimal `PATH`, so setup writes `MARSCLAW_YTDLP_PATH=<absolute-path>` into `.env`. The tool's runtime resolver checks that env var first, then common install dirs (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `/usr/bin`), then asks your login shell — so it almost always finds the binary regardless of how the service was started.

## Use it

Just send a link. The persona ([skills/core.md](https://github.com/deBilla/marsclaw/blob/main/skills/core.md)) tells the agent to auto-trigger on any `youtube.com` / `youtu.be` URL:

```
you →  https://www.youtube.com/watch?v=aircAruvnKk
bot →  Key takeaways from "But what is a neural network?":
       • A neuron is a function that holds a number 0–1 (its activation)…
```

Or explicitly: *"summarise this video with timestamps"* / *"transcribe in Spanish"*.

## Tool reference

`youtube_transcript({ url, lang?, timestamps?, max_chars? })`:

| Arg | Type | Default | Notes |
|---|---|---|---|
| `url` | string | (required) | Full URL or bare 11-char video id. Handles watch, youtu.be, shorts, embed, live |
| `lang` | string | `en` | Preferred caption language code |
| `timestamps` | bool | `false` | Prefix each line with `[mm:ss]` |
| `max_chars` | number | `100000` | Cap returned text; rest noted as truncated |

Returns `# <title> — <channel> · <duration> · lang=<code> · <id>` followed by the transcript.

## How it works

1. Resolve `yt-dlp` (env override → known paths → login shell).
2. Run `yt-dlp --skip-download --write-subs --write-auto-subs --sub-langs "<lang>-orig,<lang>" --sub-format json3 --write-info-json --extractor-args "youtube:player_client=ios,android,web"` into a temp dir.
3. If no caption file came through, inspect the info JSON for available languages; pick the best (manual > preferred-lang > original-language > anything) and retry once.
4. Parse the JSON3 events into plain text. Read title / channel / duration from the info JSON.
5. Wrap with a header line and return; the agent summarises in its reply.

The `ios`/`android` player clients are required — the default `tv` and `web` clients return empty caption lists for most videos thanks to YouTube's proof-of-origin token gate.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `yt-dlp was not found …` | Binary missing or not on any known path | Install per above, or set `MARSCLAW_YTDLP_PATH=/absolute/path/to/yt-dlp` in `.env` |
| `No transcript available …` | Video has no captions (manual or auto-generated) — common for music, very fresh uploads, or uploader-disabled captions | Find a captioned re-upload |
| `… YouTube returned no transcript data (often a transient hiccup) …` | The ios/android caption API intermittently returns an empty list even when captions exist | Send the link again |
| `Couldn't access this video …` | Private, age-restricted, region-locked, or yt-dlp couldn't reach YouTube | Check the URL; for age-gated content yt-dlp needs cookies (out of scope here) |
| Caption text is broken / wrong language | The requested `lang` wasn't available and the fallback picked a translated track | Pass `lang: "<code>"` explicitly, or accept the manual track yt-dlp found |

If yt-dlp itself breaks on a video (YouTube changes faster than yt-dlp releases occasionally), update it: `brew upgrade yt-dlp` or `pip install --user --upgrade yt-dlp`.
