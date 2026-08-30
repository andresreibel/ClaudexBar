import AppKit
import ClaudexBarCore
import Combine
import Foundation
import SwiftUI
private let cosmicOrange = Color(
    red: 1.0,
    green: 158.0 / 255.0,
    blue: 100.0 / 255.0
)


private enum EngineError: LocalizedError {
    case missingBun
    case missingScript
    case failed(String)
    case invalidOutput(String)

    var errorDescription: String? {
        switch self {
        case .missingBun:
            "Bun was not found. Install Bun at ~/.bun/bin/bun."
        case .missingScript:
            "The shared claudexbar.ts engine was not found."
        case .failed(let message):
            message
        case .invalidOutput(let output):
            "ClaudexBar returned invalid output: \(output)"
        }
    }
}

private struct EngineRunner: Sendable {
    let bunURL: URL
    let scriptURL: URL

    static func resolve() throws -> EngineRunner {
        let environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser

        let bunCandidates = [
            environment["CLAUDEXBAR_BUN"].map(URL.init(fileURLWithPath:)),
            home.appendingPathComponent(".bun/bin/bun"),
            URL(fileURLWithPath: "/opt/homebrew/bin/bun"),
            URL(fileURLWithPath: "/usr/local/bin/bun")
        ].compactMap { $0 }

        guard let bunURL = bunCandidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else {
            throw EngineError.missingBun
        }

        let scriptCandidates = [
            environment["CLAUDEXBAR_SCRIPT"].map(URL.init(fileURLWithPath:)),
            Bundle.main.resourceURL?.appendingPathComponent("claudexbar.ts"),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("claudexbar.ts"),
            home.appendingPathComponent("code/ClaudexBar/claudexbar.ts"),
            home.appendingPathComponent("Code/ClaudexBar/claudexbar.ts")
        ].compactMap { $0 }

        guard let scriptURL = scriptCandidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
            throw EngineError.missingScript
        }

        return EngineRunner(bunURL: bunURL, scriptURL: scriptURL)
    }

    func payload() async throws -> ClaudexBarPayload {
        let output = try await run(arguments: [])
        guard let data = output.data(using: .utf8) else {
            throw EngineError.invalidOutput(output)
        }
        do {
            return try JSONDecoder().decode(ClaudexBarPayload.self, from: data)
        } catch {
            throw EngineError.invalidOutput(output)
        }
    }

    func select(_ provider: ClaudexBarProvider) async throws {
        let output = try await run(arguments: ["--provider", provider.rawValue])
        guard output == provider.rawValue else {
            throw EngineError.invalidOutput(output)
        }
    }

    func signInGrok() async throws {
        let output = try await run(arguments: ["--login", "grok"])
        guard output == "grok" else {
            throw EngineError.invalidOutput(output)
        }
    }

    private func run(arguments: [String]) async throws -> String {
        try await Task.detached(priority: .userInitiated) {
            let process = Process()
            let stdout = Pipe()
            let stderr = Pipe()
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            var environment = ProcessInfo.processInfo.environment
            let existingPath = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"

            environment["PATH"] = "\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:\(existingPath)"
            process.environment = environment
            process.executableURL = bunURL
            process.arguments = [scriptURL.path] + arguments
            process.standardOutput = stdout
            process.standardError = stderr

            do {
                try process.run()
            } catch {
                throw EngineError.failed("Could not start ClaudexBar: \(error.localizedDescription)")
            }

            process.waitUntilExit()
            let output = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let errorOutput = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

            guard process.terminationStatus == 0 else {
                throw EngineError.failed(errorOutput.isEmpty ? "ClaudexBar exited with status \(process.terminationStatus)." : errorOutput)
            }
            return output
        }.value
    }
}

@MainActor
private final class ClaudexBarModel: ObservableObject {
    @Published var provider: ClaudexBarProvider
    @Published var payload: ClaudexBarPayload?
    @Published var errorMessage: String?
    @Published var isRefreshing = false

    private var timer: Timer?

    init() {
        provider = Self.readProvider()
        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.refresh()
            }
        }
    }


    var statusColor: Color {
        switch payload?.severity {
        case .error: .red
        case .critical: .red
        case .warning: cosmicOrange
        case .stale: .yellow
        case .normal, nil: .primary
        }
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let runner = try EngineRunner.resolve()
            payload = try await runner.payload()
            provider = Self.readProvider()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func select(_ nextProvider: ClaudexBarProvider) async {
        guard !isRefreshing, nextProvider != provider else { return }

        let previousProvider = provider
        let previousPayload = payload
        provider = nextProvider
        payload = nil
        errorMessage = nil
        isRefreshing = true
        defer { isRefreshing = false }

        let runner: EngineRunner
        do {
            runner = try EngineRunner.resolve()
        } catch {
            provider = previousProvider
            payload = previousPayload
            errorMessage = "Couldn't switch to \(nextProvider.displayName)."
            return
        }

        do {
            try await runner.select(nextProvider)
        } catch {
            let persistedProvider = Self.readProvider()
            guard persistedProvider == nextProvider else {
                provider = persistedProvider
                payload = persistedProvider == previousProvider ? previousPayload : nil
                errorMessage = "Couldn't switch to \(nextProvider.displayName)."
                return
            }
        }

        do {
            let nextPayload = try await runner.payload()
            payload = nextPayload
            guard nextPayload.severity != .error else {
                errorMessage = "Unable to load \(nextProvider.displayName) usage."
                return
            }
            errorMessage = nil
        } catch {
            errorMessage = "Unable to load \(nextProvider.displayName) usage."
        }
    }

    func signInGrok() async {
        guard provider == .grok, !isRefreshing else { return }
        isRefreshing = true
        errorMessage = nil
        defer { isRefreshing = false }

        do {
            let runner = try EngineRunner.resolve()
            try await runner.signInGrok()
            let nextPayload = try await runner.payload()
            payload = nextPayload
            guard nextPayload.severity != .error else {
                errorMessage = "Unable to load SpaceXAI usage."
                return
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private static func readProvider() -> ClaudexBarProvider {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/claudexbar/provider")
        guard let value = try? String(contentsOf: path, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
            let provider = ClaudexBarProvider(rawValue: value) else {
            return .codex
        }
        return provider
    }
}

private struct ClaudexBarMenu: View {
    @ObservedObject var model: ClaudexBarModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("ClaudexBar")
                        .font(.headline)
                    Text(model.provider.displayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if model.isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            Picker("Provider", selection: Binding(
                get: { model.provider },
                set: { provider in Task { await model.select(provider) } }
            )) {
                ForEach(ClaudexBarProvider.allCases, id: \.self) { provider in
                    Text(provider.displayName).tag(provider)
                }
            }
            .pickerStyle(.segmented)
            .disabled(model.isRefreshing)

            if let payload = model.payload {
                VStack(alignment: .leading, spacing: 8) {
                    Text(payload.text)
                        .font(.system(.body, design: .monospaced, weight: .semibold))
                        .foregroundStyle(model.statusColor)

                    if payload.usageRows.isEmpty {
                        if let percentage = payload.percentage {
                            usageRow(
                                label: payload.percentageLabel ?? "Usage",
                                percentage: percentage,
                                resetText: nil,
                                pacing: nil,
                                tint: model.statusColor
                            )
                        }
                    } else {
                        ForEach(Array(payload.usageRows.enumerated()), id: \.offset) { _, row in
                            usageRow(
                                label: row.label,
                                percentage: row.percentage,
                                resetText: row.resetText,
                                pacing: row.pacing,
                                tint: usageColor(for: row.severity)
                            )
                        }
                    }

                    if let credits = payload.resetCredits {
                        HStack {
                            Text("Free reset credits")
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text(credits.formatted(.number.precision(.fractionLength(0...2))))
                                .font(.system(.body, design: .monospaced, weight: .semibold))
                        }
                    }

                    let detail = payload.macOSDetail
                    if !detail.isEmpty {
                        Text(detail)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let updatedTime = payload.updatedTimeText {
                        Text("Updated \(updatedTime)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            } else if model.errorMessage == nil {
                Text("Loading usage…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let errorMessage = model.errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            if model.provider == .grok, model.payload?.authenticationRequired == true {
                Button("Sign in to SpaceXAI") {
                    Task { await model.signInGrok() }
                }
                .disabled(model.isRefreshing)
            }

            Spacer(minLength: 0)

            Divider()

            HStack {
                Button("Refresh") {
                    Task { await model.refresh() }
                }
                .disabled(model.isRefreshing)

                Spacer()

                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
            }
        }
        .padding(16)
        .frame(width: 390, height: 500, alignment: .topLeading)
        .task {
            await model.refresh()
        }
    }

    private func usageColor(for severity: ClaudexBarSeverity) -> Color {
        switch severity {
        case .critical, .error: .red
        case .warning: cosmicOrange
        case .normal, .stale: .accentColor
        }
    }

    private func usageRow(
        label: String,
        percentage: Double,
        resetText: String?,
        pacing: ClaudexBarUsagePacing?,
        tint: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            HStack {
                Text("Actual")
                Spacer()
                Text("\(formatPercentage(percentage))%")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)

            ProgressView(value: min(max(percentage, 0), 100), total: 100)
                .tint(tint)

            if let pacing {
                HStack {
                    Text("Expected")
                    Spacer()
                    Text("\(formatPercentage(pacing.expectedPercentage))%")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)

                ProgressView(
                    value: min(max(pacing.expectedPercentage, 0), 100),
                    total: 100
                )
                .tint(Color.secondary)
            }

            if let resetText {
                Text("Resets in \(resetText)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func formatPercentage(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...1)))
    }
}

@MainActor
private final class ClaudexBarAppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private let model = ClaudexBarModel()
    private let statusItem = NSStatusBar.system.statusItem(withLength: 150)
    private let popover = NSPopover()
    private var lastStatusTitle = "cdx"
    private var cancellables = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)

        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self
        popover.contentViewController = NSHostingController(rootView: ClaudexBarMenu(model: model))

        if let button = statusItem.button {
            button.target = self
            button.action = #selector(togglePopover)
            button.sendAction(on: [.leftMouseUp])
        }

        model.$payload
            .combineLatest(model.$errorMessage)
            .sink { [weak self] payload, errorMessage in
                self?.updateStatusItem(payload: payload, errorMessage: errorMessage)
            }
            .store(in: &cancellables)

        Task { await model.refresh() }
    }

    @objc private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
    }

    func popoverDidClose(_ notification: Notification) {
        updateStatusItem(payload: model.payload, errorMessage: model.errorMessage)
    }

    private func updateStatusItem(
        payload: ClaudexBarPayload?,
        errorMessage: String?
    ) {
        guard let button = statusItem.button else { return }

        if let payload {
            lastStatusTitle = payload.text
        }
        guard !popover.isShown else { return }
        let title = payload?.text ?? lastStatusTitle
        let baseFont = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        let attributedTitle = NSMutableAttributedString(
            string: title,
            attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: baseFont,
            ]
        )
        button.attributedTitle = attributedTitle
        button.toolTip = payload?.tooltip ?? errorMessage ?? "ClaudexBar"
        button.setAccessibilityLabel("ClaudexBar, \(title)")
    }
}

@main
private struct ClaudexBarApp: App {
    @NSApplicationDelegateAdaptor(ClaudexBarAppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}
