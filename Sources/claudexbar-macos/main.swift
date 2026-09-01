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

    func payloads() async throws -> ClaudexBarAggregatePayload {
        let output = try await run(arguments: ["--all"])
        guard let data = output.data(using: .utf8) else {
            throw EngineError.invalidOutput(output)
        }
        do {
            return try JSONDecoder().decode(ClaudexBarAggregatePayload.self, from: data)
        } catch {
            throw EngineError.invalidOutput(output)
        }
    }

    func reconnect(_ provider: ClaudexBarProvider) async throws {
        if provider == .grok {
            let output = try await run(arguments: ["--login", "grok"])
            guard output == "grok" else {
                throw EngineError.invalidOutput(output)
            }
            return
        }

        let command = provider == .claude ? "claude auth login" : "codex login"
        try await runLoginCommand(command)
    }

    private func runLoginCommand(_ command: String) async throws {
        try await Task.detached(priority: .userInitiated) {
            let process = Process()
            let stderr = Pipe()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-lic", command]
            process.standardOutput = Pipe()
            process.standardError = stderr

            do {
                try process.run()
            } catch {
                throw EngineError.failed("Could not start provider sign-in: \(error.localizedDescription)")
            }

            process.waitUntilExit()
            let errorOutput = String(
                data: stderr.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard process.terminationStatus == 0 else {
                throw EngineError.failed(
                    errorOutput.isEmpty ? "Provider sign-in failed." : errorOutput
                )
            }
        }.value
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
    @Published var aggregate: ClaudexBarAggregatePayload?
    @Published var errorMessage: String?
    @Published var isRefreshing = false

    private var timer: Timer?

    init() {
        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.refresh()
            }
        }
    }

    var statusTitle: String {
        aggregate?.menuBarText ?? "A --  O --  S --"
    }

    var statusTooltip: String {
        guard let aggregate else {
            return errorMessage ?? "ClaudexBar"
        }
        return ClaudexBarProvider.dashboardOrder.map { provider in
            let pace = aggregate.payload(for: provider)?.paceText ?? "--"
            return "\(provider.displayName): \(pace) weekly pace"
        }.joined(separator: "\n")
    }

    func payload(for provider: ClaudexBarProvider) -> ClaudexBarProviderPayload? {
        aggregate?.payload(for: provider)
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let runner = try EngineRunner.resolve()
            aggregate = try await runner.payloads()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func reconnect(_ provider: ClaudexBarProvider) async {
        guard !isRefreshing else { return }
        isRefreshing = true
        errorMessage = nil
        defer { isRefreshing = false }

        do {
            let runner = try EngineRunner.resolve()
            try await runner.reconnect(provider)
            aggregate = try await runner.payloads()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct ClaudexBarMenu: View {
    @ObservedObject var model: ClaudexBarModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("ClaudexBar")
                    .font(.headline)
                Spacer()
                Button {
                    Task { await model.refresh() }
                } label: {
                    if model.isRefreshing {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .buttonStyle(.plain)
                .frame(width: 24, height: 24)
                .disabled(model.isRefreshing)
                .help("Refresh all providers")
            }

            HStack(alignment: .top, spacing: 12) {
                ForEach(ClaudexBarProvider.dashboardOrder, id: \.rawValue) { provider in
                    providerColumn(provider)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)

            if let errorMessage = model.errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }

        }
        .padding(.top, 16)
        .padding(.horizontal, 16)
        .padding(.bottom, 24)
        .frame(width: 620, height: 450, alignment: .topLeading)
        .task {
            await model.refresh()
        }
    }

    @ViewBuilder
    private func providerColumn(_ provider: ClaudexBarProvider) -> some View {
        let entry = model.payload(for: provider)
        let payload = entry?.payload

        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(provider.badge)
                    .font(.system(.caption, design: .rounded, weight: .bold))
                    .frame(width: 24, height: 24)
                    .background(Circle().fill(Color.primary.opacity(0.09)))
                Text(provider.displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }

            VStack(alignment: .leading, spacing: 0) {
                Text(entry?.paceText ?? "--")
                    .font(.system(size: 26, weight: .semibold, design: .monospaced))
                    .foregroundStyle(paceColor(entry?.weeklyPace))
                Text("Weekly pace (expected − actual)")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .allowsTightening(true)
            }

            if let payload {
                if payload.usageRows.isEmpty {
                    if let percentage = payload.percentage {
                        usageRow(
                            label: payload.percentageLabel ?? "Usage",
                            percentage: percentage,
                            resetText: nil,
                            pacing: nil,
                            tint: usageColor(for: payload.severity)
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
                        Text("Reset credits")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(credits.formatted(.number.precision(.fractionLength(0...2))))
                            .font(.system(.caption, design: .monospaced, weight: .semibold))
                    }
                    .font(.caption2)
                }

                let detail = payload.macOSDetail
                if !detail.isEmpty {
                    Text(detail)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(payload.severity == .error ? Color.red : Color.secondary)
                        .textSelection(.enabled)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if payload.authenticationRequired == true {
                    Button("Reconnect") {
                        Task { await model.reconnect(provider) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.isRefreshing)
                }

                Spacer(minLength: 0)

                if let updatedTime = payload.updatedTimeText {
                    Text("Updated \(updatedTime)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            } else {
                Text("Loading usage…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
        .padding(12)
        .frame(width: 188, alignment: .topLeading)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.primary.opacity(0.045))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        )
    }

    private func usageColor(for severity: ClaudexBarSeverity) -> Color {
        switch severity {
        case .critical, .error: .red
        case .warning: cosmicOrange
        case .normal, .stale: .accentColor
        }
    }

    private func paceColor(_ pace: Double?) -> Color {
        guard let pace else { return .secondary }
        if pace < 0 { return cosmicOrange }
        if pace > 0 { return .green }
        return .secondary
    }

    private func usageRow(
        label: String,
        percentage: Double,
        resetText: String?,
        pacing: ClaudexBarUsagePacing?,
        tint: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(compactLabel(label))
                    .fontWeight(.semibold)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text("\(formatPercentage(percentage))%")
                    .monospacedDigit()
            }
            .font(.caption2)
            .foregroundStyle(.secondary)

            ProgressView(value: min(max(percentage, 0), 100), total: 100)
                .tint(tint)
                .controlSize(.small)

            if let pacing {
                HStack {
                    Text("Expected")
                    Spacer(minLength: 4)
                    Text("\(formatPercentage(pacing.expectedPercentage))%")
                        .monospacedDigit()
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)

                ProgressView(
                    value: min(max(pacing.expectedPercentage, 0), 100),
                    total: 100
                )
                .tint(Color.secondary)
                .controlSize(.small)
            }

            if let resetText {
                Text("Resets \(resetText)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func compactLabel(_ label: String) -> String {
        switch label {
        case "Cursor Models (Monthly)": "Cursor monthly"
        case "Other Models (Monthly)": "Other monthly"
        case "GrokBot (Weekly)": "GrokBot weekly"
        default: label
        }
    }

    private func formatPercentage(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...1)))
    }
}

@MainActor
private final class ClaudexBarAppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private let model = ClaudexBarModel()
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    private var lastStatusTitle = "A --  O --  S --"
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

        model.$aggregate
            .combineLatest(model.$errorMessage)
            .sink { [weak self] aggregate, errorMessage in
                self?.updateStatusItem(aggregate: aggregate, errorMessage: errorMessage)
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
        updateStatusItem(aggregate: model.aggregate, errorMessage: model.errorMessage)
    }

    private func updateStatusItem(
        aggregate: ClaudexBarAggregatePayload?,
        errorMessage: String?
    ) {
        guard let button = statusItem.button else { return }

        if let aggregate {
            lastStatusTitle = aggregate.menuBarText
        }
        guard !popover.isShown else { return }
        let title = aggregate?.menuBarText ?? lastStatusTitle
        let baseFont = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        button.attributedTitle = NSAttributedString(
            string: title,
            attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: baseFont,
            ]
        )
        button.toolTip = model.statusTooltip
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
