import SwiftUI

// Native replacement for the interactive terminal setup. Collects the same
// fields and persists them via `marsclaw apply-setup`; provider/Google login
// open the system browser via the engine. Channel tokens the user pastes here
// land in HOME/.env exactly like the TUI writes them.
struct SetupView: View {
    let engine: Engine
    let initial: EngineStatus?
    let onDone: () -> Void

    @State private var botName = "Mars"
    @State private var ownerName = ""
    @State private var timezone = TimeZone.current.identifier
    @State private var location = ""
    @State private var provider = "claude"
    @State private var telegramToken = ""
    @State private var whatsappEnabled = false
    @State private var ownerPhone = ""
    @State private var voiceEnabled = false

    @State private var busy = false
    @State private var message = ""

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Welcome to marsClaw").font(.headline)
                    Text("Your personal chat agent. Three steps to get going:")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text("1.  Pick a provider and log in (opens your browser).\n"
                        + "2.  Paste a Telegram bot token from @BotFather (or enable WhatsApp).\n"
                        + "3.  Save, then choose Start from the menubar icon.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }

            Section("Identity") {
                TextField("Bot name", text: $botName)
                TextField("Your name", text: $ownerName)
                TextField("Timezone (IANA, e.g. Asia/Colombo)", text: $timezone)
                TextField("Location (optional)", text: $location)
            }

            Section("Agent provider") {
                Picker("Provider", selection: $provider) {
                    Text("Claude (Anthropic)").tag("claude")
                    Text("Gemini (Google)").tag("gemini")
                }
                .pickerStyle(.segmented)
                Button("Log in to \(provider == "claude" ? "Claude" : "Gemini")…") {
                    engine.runInTerminal(
                        "login \(provider)",
                        note: "Logging in to \(provider) — complete the flow in your browser.")
                    message = "A Terminal window opened for \(provider) login — finish there, then come back and Save."
                }
            }

            Section("Telegram") {
                SecureField("Bot token (from @BotFather)", text: $telegramToken)
            }

            Section("WhatsApp") {
                Toggle("Enable WhatsApp", isOn: $whatsappEnabled)
                if whatsappEnabled {
                    TextField("Your number (digits only, no +)", text: $ownerPhone)
                    Button("Link WhatsApp (scan QR)…") {
                        engine.runInTerminal(
                            "whatsapp link",
                            note: "Scan the QR below with WhatsApp → Settings → Linked devices.")
                        message = "A Terminal window opened with a QR — scan it with your phone."
                    }
                    Text("Save first, then click to scan the QR. Then Start from the menubar.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            Section("Extras") {
                Toggle("Enable voice (local Whisper/Kokoro — installs on demand)", isOn: $voiceEnabled)
                Button("Connect Google account… (optional)") {
                    engine.runInTerminal(
                        "google login",
                        note: "Connecting Google — needs GOOGLE_OAUTH_CLIENT_ID/SECRET in your .env.")
                    message = "A Terminal window opened for Google login (advanced — requires your own OAuth client)."
                }
            }

            if !message.isEmpty {
                Text(message).font(.caption).foregroundStyle(.secondary)
            }

            HStack {
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Save") { save() }.keyboardShortcut(.defaultAction).disabled(busy)
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .padding()
        .onAppear(perform: hydrate)
    }

    private func hydrate() {
        guard let s = initial else { return }
        botName = s.botName
        provider = s.provider
        whatsappEnabled = s.channels.whatsapp
        voiceEnabled = s.channels.voice
    }

    private func save() {
        let payload = SetupPayload(
            botName: botName,
            ownerName: ownerName.isEmpty ? nil : ownerName,
            timezone: timezone,
            location: location.isEmpty ? nil : location,
            provider: provider,
            telegramToken: telegramToken.isEmpty ? nil : telegramToken,
            whatsappEnabled: whatsappEnabled,
            ownerPhone: ownerPhone.isEmpty ? nil : ownerPhone,
            voiceEnabled: voiceEnabled)
        busy = true
        message = "Saving…"
        engine.applySetup(payload) { ok, out in
            busy = false
            message = ok ? "Saved. Start marsClaw from the menu to apply." : "Error: \(out)"
            if ok { onDone() }
        }
    }
}
