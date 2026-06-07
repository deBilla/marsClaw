import AppKit

// Decoded shape of `marsclaw status --json`.
struct EngineStatus: Decodable {
    let botName: String
    let provider: String
    let providerAuthed: Bool
    let serviceRunning: Bool
    let channels: Channels

    struct Channels: Decodable {
        let telegram: Bool
        let slack: Bool
        let whatsapp: Bool
        let voice: Bool
    }

    var enabledChannelList: [String] {
        var out: [String] = []
        if channels.telegram { out.append("telegram") }
        if channels.slack { out.append("slack") }
        if channels.whatsapp { out.append("whatsapp") }
        if channels.voice { out.append("voice") }
        return out
    }
}

// Setup payload mirrored by `marsclaw apply-setup` (see src/cli/apply-setup.ts).
struct SetupPayload: Encodable {
    var botName: String?
    var ownerName: String?
    var timezone: String?
    var location: String?
    var provider: String?
    var telegramToken: String?
    var whatsappEnabled: Bool?
    var ownerPhone: String?
    var voiceEnabled: Bool?
}

// Locates the bundled engine binary + read-only assets, owns the writable HOME
// directory, and runs engine subcommands with MARSCLAW_HOME / MARSCLAW_ASSETS
// set. The engine is the single source of truth; this class never reaches into
// data/ or .env itself.
final class Engine {
    let binaryURL: URL
    let assetsURL: URL
    /// ~/Library/Application Support/marsClaw — writable user state.
    let homeURL: URL

    init() {
        let res = Bundle.main.resourceURL!.appendingPathComponent("engine")
        // The package script may ship a per-arch layout (engine/arm64, engine/x64)
        // or a single flat engine/ dir. Prefer the arch dir if present.
        let archDir = res.appendingPathComponent(Engine.machineArch())
        let hasArchDir = FileManager.default.fileExists(
            atPath: archDir.appendingPathComponent("marsclaw").path)
        let base = hasArchDir ? archDir : res
        binaryURL = base.appendingPathComponent("marsclaw")
        assetsURL = base.appendingPathComponent("assets")
        homeURL = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("marsClaw", isDirectory: true)
    }

    static func machineArch() -> String {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { raw -> String in
            String(cString: raw.bindMemory(to: CChar.self).baseAddress!)
        }
        return machine == "x86_64" ? "x64" : "arm64"
    }

    func ensureHome() {
        try? FileManager.default.createDirectory(
            at: homeURL.appendingPathComponent("logs"), withIntermediateDirectories: true)
    }

    private func makeProcess(_ args: [String]) -> Process {
        let p = Process()
        p.executableURL = binaryURL
        p.arguments = args
        p.currentDirectoryURL = homeURL
        var env = ProcessInfo.processInfo.environment
        env["MARSCLAW_HOME"] = homeURL.path
        env["MARSCLAW_ASSETS"] = assetsURL.path
        p.environment = env
        return p
    }

    /// Run a subcommand to completion, capturing combined stdout+stderr.
    /// Call off the main thread — it blocks until the process exits.
    @discardableResult
    func run(_ args: [String], stdin: String? = nil) -> (status: Int32, out: String) {
        let p = makeProcess(args)
        let outPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = outPipe
        if let stdin {
            let inPipe = Pipe()
            p.standardInput = inPipe
            inPipe.fileHandleForWriting.write(Data(stdin.utf8))
            inPipe.fileHandleForWriting.closeFile()
        }
        do { try p.run() } catch { return (1, "failed to launch engine: \(error)") }
        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    /// Fetch a status snapshot. The engine prints log lines before the JSON, so
    /// we slice from the first '{'.
    func status(_ completion: @escaping (EngineStatus?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let (_, out) = self.run(["status", "--json"])
            guard let brace = out.firstIndex(of: "{"),
                  let data = String(out[brace...]).data(using: .utf8),
                  let status = try? JSONDecoder().decode(EngineStatus.self, from: data)
            else { DispatchQueue.main.async { completion(nil) }; return }
            DispatchQueue.main.async { completion(status) }
        }
    }

    func applySetup(_ payload: SetupPayload, _ completion: @escaping (Bool, String) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            guard let json = try? JSONEncoder().encode(payload),
                  let str = String(data: json, encoding: .utf8)
            else { DispatchQueue.main.async { completion(false, "encode failed") }; return }
            // Pass the JSON as an argv (apply-setup accepts argv[3] or stdin).
            // argv avoids the pipe-before-launch timing that made Save flaky.
            let r = self.run(["apply-setup", str])
            DispatchQueue.main.async { completion(r.status == 0, r.out) }
        }
    }

    /// Run an engine subcommand in a real Terminal window the user can see and
    /// interact with. Used for INTERACTIVE flows — `login`/`google login` (the
    /// CLIs draw a TUI + open a browser) and `whatsapp link` (renders a QR to
    /// scan). Capturing these in a pipe makes them hang and show nothing.
    func runInTerminal(_ sub: String, note: String) {
        let script = """
        #!/bin/bash
        export MARSCLAW_HOME="\(homeURL.path)"
        export MARSCLAW_ASSETS="\(assetsURL.path)"
        cd "$MARSCLAW_HOME"
        echo "\(note)"
        echo
        "\(binaryURL.path)" \(sub)
        echo
        echo "All done — you can close this window and return to marsClaw."

        """
        let slug = sub.replacingOccurrences(of: " ", with: "-")
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("marsclaw-\(slug).command")
        try? script.write(to: tmp, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: tmp.path)
        NSWorkspace.shared.open(tmp)  // opens in Terminal.app
    }

    func openLogs() { NSWorkspace.shared.open(homeURL.appendingPathComponent("logs")) }
    func openHome() { NSWorkspace.shared.open(homeURL) }
}
