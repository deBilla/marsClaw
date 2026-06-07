# Packaging marsClaw as a macOS app (.dmg)

This turns the dev-checkout bot into a double-click app a non-technical user can
install: **no Node, Bun, nvm, git, or terminal**. Everything the app needs at
runtime is bundled and code-signed; optional heavy features install on demand.

## Shape

```
marsClaw.app/Contents/
  MacOS/marsClaw                  ← Swift menubar app (macapp/)
  Resources/engine/
    <arch>/marsclaw               ← compiled Bun engine (the whole TS app)
    <arch>/assets/                ← CLAUDE.md, skills/, migrations/, … (read-only)
  Info.plist                      ← LSUIElement (menubar-only)
```

Writable user state lives **outside** the (read-only, signed) bundle:

```
~/Library/Application Support/marsClaw/   ← MARSCLAW_HOME
  .env  data/  MEMORY.md  wiki/  skills/  logs/
```

The menubar app launches the engine with `MARSCLAW_HOME` + `MARSCLAW_ASSETS` set;
`src/lib/bootstrap.ts` chdirs into HOME, syncs the persona out of the bundle, and
seeds first-run files. See [container-runtime.md](container-runtime.md) and
[architecture.md](architecture.md) for the engine itself.

## Build the engine

```bash
bun run build:engine          # host arch → dist/engine/<arch>/{marsclaw,assets}
bun run build:engine --all    # arm64 + x64 (for a universal app)
```

The build is `scripts/build-engine.ts` (Bun.build `--compile` + a plugin that
embeds `@google/gemini-cli-core`'s `*.wasm?binary` tree-sitter modules inline —
`--external` is impossible because a compiled Bun binary can't load externals
from disk).

## Build the menubar app

`macapp/` is a SwiftPM executable (no `.xcodeproj` needed):

```bash
cd macapp && swift build -c release            # or: open Package.swift in Xcode
```

It talks to the engine only through documented subcommands:
`status --json`, `apply-setup` (writes `.env` + `data/config.json`), `login`
(browser OAuth), `service`-style start/stop (the app writes its own LaunchAgent,
`com.marsclaw.agent`, pointing at the bundled binary).

## Sign, notarize, and DMG

One command does engine → app → bundle → sign → notarize → DMG:

```bash
export SIGN_ID="Developer ID Application: Your Name (TEAMID)"
# one-time: store notarization credentials in the keychain
xcrun notarytool store-credentials NOTARY_PROFILE \
  --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
export NOTARY_PROFILE=NOTARY_PROFILE

./scripts/package-mac.sh        # → dist/marsClaw.dmg (notarized + stapled)
```

Local smoke build without an Apple account (Gatekeeper will warn; right-click →
Open):

```bash
./scripts/package-mac.sh --adhoc
```

The hardened-runtime entitlements (`macapp/marsClaw.entitlements`) grant JIT +
unsigned-executable-memory (the Bun engine JITs) and library-validation off (the
app launches a separately-signed nested binary). The app is **not** sandboxed —
it manages a LaunchAgent and writes to `~/Library`.

## Provider runtime in the compiled binary

Both agent SDKs reach for native binaries / runtime asset files that
`bun --compile` does **not** bundle into the binary's virtual fs. Each needed a
targeted fix so the in-process agent works in the packaged app:

- **Gemini** (the free default). `@google/gemini-cli-core` does two runtime reads
  that fail in a compiled binary:
  - tree-sitter `*.wasm?binary` shell-parser modules — embedded inline by the
    `wasmBinaryPlugin` in `scripts/build-engine.ts` (so they ship inside the
    binary; `--external` is impossible, a compiled binary can't load externals
    from disk).
  - `policy/policies/sandbox-default.toml` — read via an `import.meta.url`-relative
    path that resolves to `/$bunfs/root/...` and isn't on disk, so the loader
    threw. Patched (`bun patch`, recorded in `package.json` →
    `patches/@google%2Fgemini-cli-core@*.patch`, auto-reapplied on `bun install`)
    to fall back to its own built-in defaults instead of throwing.
- **Claude.** `@anthropic-ai/claude-agent-sdk` spawns the native `claude` CLI,
  which isn't bundled. `src/providers/claude-sdk.ts` resolves the system install
  (`~/.local/bin/claude`, Homebrew paths, or `MARSCLAW_CLAUDE_CLI`) and passes it
  as `pathToClaudeCodeExecutable`.

**Clean-machine caveat:** the above make both providers work *when the provider
CLI / auth already exists on the machine*. A brand-new Mac still needs the
provider CLI installed + logged in (`marsclaw login` surfaces a clear hint when
the bin is missing). Bundling the provider runtime + auth so a fresh Mac needs
nothing is the last "zero-dependency" piece — see W4 below.

## Open questions / TODO

- **Clean-machine provider runtime (W4).** Ship/install the `gemini`/`claude` CLI
  and drive first-run login so a fresh Mac needs nothing pre-installed.
- **Optional features (W4).** Container mode (Colima + docker) and voice
  (Python/ffmpeg/whisper/kokoro) are on-demand installs driven from the GUI;
  their sidecars need compiled-in `_sidecar` subcommands (the loose `tools/*.ts`
  can't run from a single binary). Not wired yet.
- **Icon.** Add `Resources/marsClaw.icns` and an `CFBundleIconFile` key.

### Done since first draft
- WhatsApp QR linking — `marsclaw whatsapp link` renders the QR; the GUI's "Link
  WhatsApp (scan QR)…" button opens it in a Terminal window.
- GUI Setup writes config via `marsclaw apply-setup` (argv); `status --json` and
  `login` back the menubar app.
- GUI **Start** clears the crash circuit-breaker so a corrected config isn't held
  back by an earlier "no channels" backoff.
