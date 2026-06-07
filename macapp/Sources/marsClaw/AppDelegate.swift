import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var setupWindow: NSWindow?
    private let engine = Engine()
    private var refreshTimer: Timer?
    private var lastStatus: EngineStatus?

    func applicationDidFinishLaunching(_ notification: Notification) {
        engine.ensureHome()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            // Guarantee a visible item: prefer the SF Symbol, but fall back to a
            // text title if it fails to load, so the menubar item is never an
            // invisible zero-width button.
            if let img = NSImage(
                systemSymbolName: "bubble.left.and.bubble.right", accessibilityDescription: "marsClaw") {
                img.isTemplate = true
                button.image = img
            }
            if button.image == nil { button.title = "marsClaw" }
        }

        rebuildMenu()  // immediate (no status yet)

        // First run: no config file yet → open Setup automatically as the guide,
        // so a new user isn't left staring at a silent menubar icon.
        let firstRun = !FileManager.default.fileExists(
            atPath: engine.homeURL.appendingPathComponent(".env").path)

        engine.status { [weak self] status in
            self?.lastStatus = status
            self?.rebuildMenu()
            if firstRun { self?.openSetup() }
        }

        // Poll status so the menu reflects start/stop/login changes.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    private func refresh() {
        engine.status { [weak self] status in
            self?.lastStatus = status
            self?.rebuildMenu()
        }
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        let s = lastStatus
        // Source of truth for run-state is OUR LaunchAgent (com.marsclaw.agent) —
        // not status.serviceRunning, which reflects the dev `com.marsclaw` label.
        let running = ServiceManager.isRunning()

        let botName = s?.botName ?? "marsClaw"
        menu.addItem(disabled("\(botName) · \(running ? "running" : "stopped")"))

        if let s {
            menu.addItem(disabled("Provider: \(s.provider)\(s.providerAuthed ? "" : " — not logged in")"))
            let chans = s.enabledChannelList
            menu.addItem(disabled("Channels: \(chans.isEmpty ? "none" : chans.joined(separator: ", "))"))
        }

        menu.addItem(.separator())

        menu.addItem(action(running ? "Stop" : "Start", #selector(toggleService)))
        menu.addItem(action("Setup…", #selector(openSetup)))

        menu.addItem(.separator())
        menu.addItem(action("Open Logs", #selector(openLogs)))
        menu.addItem(action("Open Data Folder", #selector(openData)))

        menu.addItem(.separator())
        menu.addItem(action("Quit marsClaw", #selector(quit), key: "q"))

        statusItem.menu = menu
    }

    // MARK: menu builders

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func action(_ title: String, _ sel: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        item.target = self
        return item
    }

    // MARK: actions

    @objc private func toggleService() {
        let running = ServiceManager.isRunning()
        DispatchQueue.global(qos: .userInitiated).async {
            if running { _ = ServiceManager.stop() } else { _ = ServiceManager.start(engine: self.engine) }
            DispatchQueue.main.async { self.refresh() }
        }
    }

    @objc private func openSetup() {
        if setupWindow == nil {
            let view = SetupView(engine: engine, initial: lastStatus, onDone: { [weak self] in self?.refresh() })
            let hosting = NSHostingController(rootView: view)
            // Give the hosting controller an explicit size so the window doesn't
            // come up zero-height before SwiftUI's layout settles.
            hosting.preferredContentSize = NSSize(width: 480, height: 640)
            let window = NSWindow(contentViewController: hosting)
            window.title = "marsClaw Setup"
            window.styleMask = [.titled, .closable, .miniaturizable]
            window.setContentSize(NSSize(width: 480, height: 640))
            window.isReleasedWhenClosed = false
            setupWindow = window
        }
        // An .accessory (menubar-only) app doesn't own the active state, so a
        // plain makeKeyAndOrderFront can open the window behind everything.
        // Activate the app and force the window front.
        NSApp.activate(ignoringOtherApps: true)
        setupWindow?.center()
        setupWindow?.makeKeyAndOrderFront(nil)
        setupWindow?.orderFrontRegardless()
    }

    @objc private func openLogs() { engine.openLogs() }
    @objc private func openData() { engine.openHome() }
    @objc private func quit() { NSApp.terminate(nil) }
}
