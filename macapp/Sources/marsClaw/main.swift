import AppKit

// Menubar-only agent app: no Dock icon, no main window. The .accessory
// activation policy is the programmatic equivalent of Info.plist LSUIElement=1
// (we set both — the plist for a clean launch, this as a belt-and-braces).
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
