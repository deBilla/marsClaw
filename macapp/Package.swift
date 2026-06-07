// swift-tools-version:5.9
import PackageDescription

// marsClaw menubar app. A SwiftPM executable so it builds without an .xcodeproj
// (CI-friendly) — scripts/package-mac.sh wraps the built binary into the signed
// marsClaw.app bundle. No third-party dependencies; AppKit + SwiftUI only.
let package = Package(
    name: "marsClaw",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "marsClaw", path: "Sources/marsClaw")
    ]
)
