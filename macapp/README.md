# macapp — marsClaw menubar app

A small AppKit + SwiftUI menubar app (SwiftPM executable, no third-party deps)
that wraps the compiled Bun engine into a no-terminal macOS experience.

```
Sources/marsClaw/
  main.swift            NSApplication (.accessory — menubar only)
  AppDelegate.swift     NSStatusItem menu: status, start/stop, setup, logs, quit
  Engine.swift          locates bundled engine + assets, runs subcommands with
                        MARSCLAW_HOME/ASSETS; decodes `status --json`
  ServiceManager.swift  installs/loads the com.marsclaw.agent LaunchAgent
  SetupView.swift       SwiftUI setup form → `marsclaw apply-setup` + `login`
Package.swift           executable target (macOS 13+)
Info.plist              bundle metadata (LSUIElement)
marsClaw.entitlements   hardened-runtime entitlements (JIT, network)
```

Build: `swift build -c release` (or open `Package.swift` in Xcode).
It does nothing useful until wrapped into `marsClaw.app` next to a compiled
engine — see [`../docs/packaging-mac.md`](../docs/packaging-mac.md).

The app never reads `data/` or `.env` directly; the engine is the single source
of truth, reached only through documented subcommands.
