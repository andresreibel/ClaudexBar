import AppKit
import ClaudexBarCore
import Combine
import Foundation
import ServiceManagement
import SwiftUI

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
        _ = try await run(arguments: ["--provider", provider.rawValue])
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
    @Published var launchAtLogin = SMAppService.mainApp.status == .enabled

    private var timer: Timer?

    init() {
        provider = Self.readProvider()
        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.refresh()
            }
        }
    }

    var menuBarText: String {
        if isRefreshing, payload == nil { return "cdx …" }
        return payload?.text ?? "cdx"
    }

    var statusColor: Color {
        switch payload?.severity {
        case .error: .red
        case .critical: .red
        case .warning: .orange
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
        guard nextProvider != provider else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let runner = try EngineRunner.resolve()
            try await runner.select(nextProvider)
            provider = nextProvider
            payload = try await runner.payload()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            launchAtLogin = SMAppService.mainApp.status == .enabled
            errorMessage = nil
        } catch {
            launchAtLogin = SMAppService.mainApp.status == .enabled
            errorMessage = "Launch at login: \(error.localizedDescription)"
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

private extension NSColor {
    convenience init?(hex: String) {
        let value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard value.count == 6, let rgb = UInt64(value, radix: 16) else { return nil }
        self.init(
            red: CGFloat((rgb >> 16) & 0xff) / 255,
            green: CGFloat((rgb >> 8) & 0xff) / 255,
            blue: CGFloat(rgb & 0xff) / 255,
            alpha: 1
        )
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

            if let payload = model.payload {
                VStack(alignment: .leading, spacing: 8) {
                    Text(payload.text)
                        .font(.system(.body, design: .monospaced, weight: .semibold))
                        .foregroundStyle(model.statusColor)

                    if let percentage = payload.percentage {
                        ProgressView(value: min(max(percentage, 0), 100), total: 100)
                            .tint(model.statusColor)
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

                    Text(payload.macOSDetail)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                }
            } else {
                Text(model.errorMessage ?? "Loading usage…")
                    .font(.caption)
                    .foregroundStyle(model.errorMessage == nil ? Color.secondary : Color.red)
            }

            if let errorMessage = model.errorMessage, model.payload != nil {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Divider()

            HStack {
                Button("Refresh") {
                    Task { await model.refresh() }
                }
                .disabled(model.isRefreshing)

                Toggle("Launch at Login", isOn: Binding(
                    get: { model.launchAtLogin },
                    set: { model.setLaunchAtLogin($0) }
                ))
                .toggleStyle(.checkbox)

                Spacer()

                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
            }
        }
        .padding(16)
        .frame(width: 390)
        .task {
            await model.refresh()
        }
    }
}

@MainActor
private final class ClaudexBarAppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private let model = ClaudexBarModel()
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
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
            .combineLatest(model.$isRefreshing)
            .sink { [weak self] _, _ in
                self?.updateStatusItem()
            }
            .store(in: &cancellables)

        model.$errorMessage
            .sink { [weak self] _ in
                self?.updateStatusItem()
            }
            .store(in: &cancellables)

        updateStatusItem()
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

    private func updateStatusItem() {
        guard let button = statusItem.button else { return }

        let title = model.menuBarText
        let severity = model.payload?.severity ?? .normal
        let baseFont = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        let accentFont = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
        let attributedTitle = NSMutableAttributedString(
            string: title,
            attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: baseFont,
            ]
        )
        if let color = severity.macOSStatusColorHex.flatMap(NSColor.init(hex:)) {
            for index in title.indices where ClaudexBarSeverity.isStatusAccentSymbol(title[index]) {
                let nextIndex = title.index(after: index)
                attributedTitle.addAttributes(
                    [.foregroundColor: color, .font: accentFont],
                    range: NSRange(index..<nextIndex, in: title)
                )
            }
        }
        button.attributedTitle = attributedTitle
        button.toolTip = model.payload?.tooltip ?? model.errorMessage ?? "ClaudexBar"
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
