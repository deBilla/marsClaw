# Development

## Layout

```
marsclaw/
├── src/
│   ├── index.ts            # process root: channels, approval intercept, dispatcher, outbox drain
│   ├── agent.ts            # per-message handler: picks provider/runtime, failover, typing
│   ├── voice.ts            # Whisper / Kokoro HTTP clients
│   │
│   ├── channels/
│   │   ├── router.ts       # dispatch outbound by thread-id prefix
│   │   ├── types.ts        # Channel / SendOpts interfaces
│   │   ├── telegram.ts     # node-telegram-bot-api (text + voice)
│   │   ├── slack.ts        # @slack/bolt, Socket Mode (text + inbound files)
│   │   ├── whatsapp.ts     # baileys (the big one)
│   │   └── whatsapp-link.ts# one-shot owner pairing
│   │
│   ├── providers/
│   │   ├── registry.ts     # pickProvider()
│   │   ├── types.ts        # Provider interface
│   │   ├── claude-sdk.ts   # in-process @anthropic-ai/claude-agent-sdk path
│   │   ├── container-client.ts  # POST /turn to the agent container
│   │   ├── container-runtime.ts # container lifecycle + host sidecars
│   │   ├── message-stream.ts    # async-iterable prompt stream (shared with container)
│   │   ├── claude.ts       # bin + isAuthed + isUsingMeteredApi
│   │   ├── claude-error.ts # classify hard vs transient errors
│   │   ├── gemini-sdk.ts   # @google/gemini-cli-core in-process path
│   │   └── gemini.ts       # bin + isAuthed metadata
│   │
│   ├── mcp/
│   │   ├── build-server.ts # the ONE tool list + handlers (both transports)
│   │   ├── server.ts       # stdio transport (in-process; one child per thread)
│   │   ├── http-server.ts  # HTTP transport (container mode; /mcp/<threadId>)
│   │   ├── thread-context.ts # currentThreadId(): AsyncLocalStorage, env fallback
│   │   ├── send.ts         # send_message
│   │   ├── send_file.ts    # send_file (allowed_paths + sensitive-path gate)
│   │   ├── speak.ts        # kokoro TTS → outbox row with audio_path
│   │   ├── youtube.ts      # youtube_transcript (yt-dlp)
│   │   ├── gmail.ts        # gmail_recent / search / get / send
│   │   ├── contacts.ts     # contacts_search
│   │   ├── calendar.ts     # list / create / raw
│   │   ├── drive.ts        # search / read / raw
│   │   ├── sheets.ts       # read / write / raw
│   │   ├── docs.ts         # read / raw
│   │   ├── slides.ts       # read / raw
│   │   └── google_accounts.ts
│   │
│   ├── google/
│   │   ├── auth.ts         # OAuth installed-app flow, multi-account index
│   │   ├── keychain.ts     # macOS Keychain wrapper + data/secrets/ fallback
│   │   ├── clients.ts      # googleapis client factories
│   │   ├── contacts.ts     # People API helpers
│   │   ├── gmail.ts        # Gmail helpers shared by MCP tool + `google test`
│   │   ├── errors.ts       # Google API error → friendly text
│   │   └── raw.ts          # raw method escape hatch
│   │
│   ├── db/
│   │   ├── connection.ts   # bun:sqlite open + pragmas, DB_PATH
│   │   ├── migrations.ts   # run migrations/*.sql, tracked in schema_migrations
│   │   ├── messages.ts     # append / load history
│   │   ├── outbox.ts       # take / mark delivered / mark failed
│   │   ├── sessions.ts     # provider session_id per thread
│   │   └── approvals.ts    # pending_approvals rows
│   │
│   ├── lib/
│   │   ├── config.ts       # config.json + env precedence
│   │   ├── env.ts          # .env key reader (setup/CLI helpers)
│   │   ├── log.ts          # structured logger + crash ring buffer
│   │   ├── log-rotate.ts   # MARSCLAW_LOG_FILE rotation
│   │   ├── tool-permissions.ts  # canUseTool gate
│   │   ├── sensitive-paths.ts   # off-limits paths, symlink-resolved
│   │   ├── url-allowlist.ts     # WebFetch host matching
│   │   ├── mutation-gate.ts     # Google-write refuse / allow / approve
│   │   ├── approval-gate.ts     # nonce generation, prompt, interception
│   │   ├── audit-log.ts         # logs/audit.log + density alerter
│   │   ├── command-gate.ts      # drop CLI slash-commands (/help, /clear…)
│   │   ├── attachment-safety.ts # untrusted filename check
│   │   ├── turn-context.ts # per-turn ambient context (time/tz/location)
│   │   ├── timezone.ts
│   │   ├── typing.ts       # typing indicator refresher
│   │   ├── heartbeat.ts    # data/heartbeat
│   │   ├── circuit-breaker.ts   # startup backoff after crashes
│   │   ├── rate-limit.ts        # per-sender sliding windows
│   │   ├── cost-tracker.ts      # data/usage.jsonl + daily cap
│   │   ├── conversation-archive.ts # conversations/*.md on compaction
│   │   ├── health-server.ts     # opt-in 127.0.0.1 /health
│   │   ├── backup.ts            # daily DB + MEMORY.md + WA auth backup
│   │   ├── launchd.ts           # launchctl wrappers
│   │   └── atomic.ts            # writeAtomic
│   │
│   └── cli/
│       ├── index.ts        # subcommand router
│       ├── setup.ts        # interactive bootstrap
│       ├── status.ts, provider.ts, whatsapp.ts, voice.ts, google.ts
│       ├── slack.ts, slack-setup.ts   # slack connect/status/disconnect + manifest
│       ├── container.ts    # container enable/disable/login/status
│       ├── service.ts      # launchd install/start/stop (+ --hardened)
│       ├── path.ts         # allowed_paths management
│       ├── backup.ts, db.ts, usage.ts, update.ts, smoke.ts
│       └── branding.ts     # the marsClaw ASCII banner
│
├── container/agent-service/ # in-container SDK service (index.ts, Dockerfile, run.sh)
├── tools/
│   ├── whisper-server.py, kokoro-server.py, setup-voice.sh   # voice sidecars
│   ├── llm-proxy/          # credential-isolation proxy
│   ├── egress-gateway/     # SSRF-filtered forward proxy
│   └── sandbox/            # legacy sandbox-exec / bubblewrap / pf (being retired)
│
├── migrations/             # SQL, run on every boot
├── tests/                  # bun test
├── skills/                 # @skills/<name>.md sub-instructions
├── launchd/                # plist templates (plain + hardened)
├── website/                # Docusaurus site built from docs/
├── docs/                   # you are here
├── wiki/                   # optional knowledge base (gitignored)
├── data/, logs/, conversations/, crashes/   # gitignored runtime state
├── CLAUDE.md               # agent persona (Claude)
├── GEMINI.md               # agent persona (Gemini)
├── MEMORY.md               # agent's own notes (gitignored)
└── MEMORY.template.md      # seed copied on first run
```

## Local dev loop

```bash
bun install
bun run setup        # if .env / data/config.json don't exist yet
bun run start        # foreground

bun run typecheck    # tsc --noEmit
bun run lint
bun run lint:fix
bun run format
bun run test         # bun test tests, with LOG_LEVEL=error
bun run test:watch
```

A husky pre-commit hook runs Prettier + ESLint. CI ([.github/workflows/ci.yml](https://github.com/deBilla/marsclaw/blob/main/.github/workflows/ci.yml)) runs `bun install --frozen-lockfile`, typecheck, lint and tests; [docs.yml](https://github.com/deBilla/marsclaw/blob/main/.github/workflows/docs.yml) builds and publishes the Docusaurus site from `docs/` (the sidebar is in `website/sidebars.js` — add new pages there).

## Tests

In [tests/](https://github.com/deBilla/marsclaw/blob/main/tests/):

| File | What it covers |
|---|---|
| `approval-gate.test.ts`     | nonce generation, prompt rendering, interception |
| `attachment-safety.test.ts` | untrusted filename validation |
| `audit-log.test.ts`         | JSONL records + denial-density alerting |
| `circuit-breaker.test.ts`   | startup backoff math |
| `claude-error.test.ts`      | hard-error classification |
| `command-gate.test.ts`      | slash-command filtering |
| `conversation-archive.test.ts` | archive writes |
| `cost-tracker.test.ts`      | daily spend math + budget gate |
| `migrations.test.ts`        | sql migrations run, idempotent |
| `mutation-gate.test.ts`     | flag / approval modes, mutating-method detection |
| `outbox.test.ts`            | take/deliver/fail semantics |
| `rate-limit.test.ts`        | per-sender windows |
| `ssrf.test.ts`              | egress-gateway IP classifier |
| `tool-permissions.test.ts`  | `canUseTool`: paths, sensitive paths, shell/web flags, allow-list |
| `url-allowlist.test.ts`     | host matching, look-alikes, IDN |
| `youtube.test.ts`           | video-id parsing from URL shapes |

## Adding a channel

1. Add a file under [src/channels/](https://github.com/deBilla/marsclaw/blob/main/src/channels/) that exports `create<Name>Channel({ ..., onMessage }): Channel`.
2. Use `<name>:<upstream-id>` for thread IDs — the router dispatches outbound sends back to you by that prefix.
3. Wire it up in [src/index.ts](https://github.com/deBilla/marsclaw/blob/main/src/index.ts) behind a feature flag (env var or `data/config.json` field).
4. Implement `setTyping` if the upstream supports it. Channels without it get a no-op.

`SendOpts` supports `audioPath` (voice notes) and `filePath` + `fileName` (file delivery). Implement what your channel can render; the rest is sent as plain text.

## Adding an MCP tool

1. Add a file in [src/mcp/](https://github.com/deBilla/marsclaw/blob/main/src/mcp/) exporting `{ definition, handler }` shaped like the existing tools.
2. Register it in the `tools` array in [src/mcp/build-server.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/build-server.ts) — both transports pick it up.
3. Add `mcp__marsclaw__<name>` to `MARSCLAW_MCP_TOOLS` in [tool-permissions.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/tool-permissions.ts) (pre-allowed for the SDK; `canUseTool` allows `mcp__*` anyway).
4. Resolve the chat with `currentThreadId()` from [thread-context.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/thread-context.ts) — not `process.env.MARSCLAW_THREAD_ID` directly, or it breaks in container mode. If your tool writes to the outbox or touches files, follow [send_file.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/send_file.ts) (sensitive-path + `allowed_paths` checks).
5. If it acts outwardly (sends, writes, deletes), gate it with `blockIfMutationsDisabled(tool, summary)` from [mutation-gate.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/mutation-gate.ts), passing a structured human-readable summary for the approval prompt.
6. If your tool calls a Google API, get an authed client via [src/google/clients.ts](https://github.com/deBilla/marsclaw/blob/main/src/google/clients.ts).

Restart the bot. The agent will discover the new tool via the standard MCP list-tools handshake.

## Adding a provider

1. Add a file in [src/providers/](https://github.com/deBilla/marsclaw/blob/main/src/providers/) that exports a `Provider` per [src/providers/types.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/types.ts):

   ```ts
   export const myprovider: Provider = {
     name: 'myprovider',
     bin: process.env.MYPROVIDER_BIN ?? 'myprovider',
     npmPackage: '@vendor/myprovider-cli',
     buildArgs(prompt) { return ['-p', prompt]; },
     isAuthed() { /* synchronous, side-effect-free */ },
   };
   ```

2. Add a `run<Provider>Sdk(...)` — both current providers are in-process SDKs; `bin`/`buildArgs` are only used by setup for install/login checks.
3. Wire both into [src/providers/registry.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/registry.ts) and the `agent_provider` union in [src/lib/config.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/config.ts).
4. Add a branch in [src/agent.ts](https://github.com/deBilla/marsclaw/blob/main/src/agent.ts) and a friendly-error mapper if your provider has rate-limit quirks.

## Personas

Two files, same purpose, kept separately because the upstream SDKs read different filenames:

- [GEMINI.md](https://github.com/deBilla/marsclaw/blob/main/GEMINI.md) — read by `@google/gemini-cli-core`
- [CLAUDE.md](https://github.com/deBilla/marsclaw/blob/main/CLAUDE.md) — read by `@anthropic-ai/claude-agent-sdk` (and explicitly by the container agent-service)

Nothing syncs them automatically, and they have already drifted (`CLAUDE.md` has the `send_file` tool and two extra behaviour rules). If you tweak one, mirror to the other by hand.

## Migrations

Drop a new file in [migrations/](https://github.com/deBilla/marsclaw/blob/main/migrations/) with the next sequential number (currently `0006_…sql`). It runs on the next boot via [src/db/migrations.ts](https://github.com/deBilla/marsclaw/blob/main/src/db/migrations.ts), which records applied versions in a `schema_migrations` table. Migrations are append-only; once shipped, never edit a previous file — write a new one.

## Style

- TypeScript strict mode, `bun:sqlite`, ESLint flat config, Prettier.
- Comments are sparse but real: when there's a non-obvious reason for code, the comment explains *why* (an incident, an invariant, an upstream quirk). Mimic the style of existing files.
- No try-catch-all (`eslint-plugin-no-catch-all` enforces this). Catch specific types.
- Tests use Bun's built-in runner (`bun test`).
