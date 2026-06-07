import Foundation

// Manages the background LaunchAgent that runs the engine (`marsclaw start`) and
// keeps it alive across logout/reboot. We write our OWN plist pointing at the
// bundled binary with MARSCLAW_HOME/ASSETS — the engine's `service install`
// renders a plist for the dev checkout (bun + repo paths) which is wrong for a
// packaged app, so the GUI owns the plist instead.
//
// Label is com.marsclaw.agent (distinct from the dev `com.marsclaw`) so a
// developer's source-run service and the installed app don't fight.
enum ServiceManager {
    static let label = "com.marsclaw.agent"

    private static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    private static var uid: String { String(getuid()) }

    static func isRunning() -> Bool {
        // `launchctl print gui/<uid>/<label>` exits 0 when the service is loaded.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["print", "gui/\(uid)/\(label)"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    @discardableResult
    static func start(engine: Engine) -> Bool {
        writePlist(engine: engine)
        // Clear the crash circuit-breaker: an explicit Start means the user just
        // (re)configured things, so they shouldn't inherit a backoff from earlier
        // "No channels" crashes that happened before setup was complete.
        try? FileManager.default.removeItem(
            at: engine.homeURL.appendingPathComponent("data/circuit-breaker.json"))
        // Replace any existing instance, then bootstrap into the GUI domain.
        launchctl(["bootout", "gui/\(uid)/\(label)"])  // ignore failure (may not be loaded)
        return launchctl(["bootstrap", "gui/\(uid)", plistURL.path])
    }

    @discardableResult
    static func stop() -> Bool {
        launchctl(["bootout", "gui/\(uid)/\(label)"])
    }

    private static func writePlist(engine: Engine) {
        let logs = engine.homeURL.appendingPathComponent("logs")
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(
            at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        let dict: [String: Any] = [
            "Label": label,
            "ProgramArguments": [engine.binaryURL.path, "start"],
            "EnvironmentVariables": [
                "MARSCLAW_HOME": engine.homeURL.path,
                "MARSCLAW_ASSETS": engine.assetsURL.path,
            ],
            "WorkingDirectory": engine.homeURL.path,
            "RunAtLoad": true,
            "KeepAlive": ["SuccessfulExit": false, "Crashed": true],
            "StandardOutPath": logs.appendingPathComponent("agent.out.log").path,
            "StandardErrorPath": logs.appendingPathComponent("agent.err.log").path,
            "ProcessType": "Background",
        ]
        if let data = try? PropertyListSerialization.data(
            fromPropertyList: dict, format: .xml, options: 0) {
            try? data.write(to: plistURL)
        }
    }

    @discardableResult
    private static func launchctl(_ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = args
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
        return p.terminationStatus == 0
    }
}
