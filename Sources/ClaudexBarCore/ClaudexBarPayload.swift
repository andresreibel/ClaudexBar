import Foundation

public enum ClaudexBarProvider: String, CaseIterable, Codable, Sendable {
    case codex
    case claude
    case grok

    public var displayName: String {
        switch self {
        case .codex: "OpenAI"
        case .claude: "Anthropic"
        case .grok: "SpaceXAI"
        }
    }

    public var badge: String {
        switch self {
        case .codex: "O"
        case .claude: "A"
        case .grok: "G"
        }
    }
}

public enum ClaudexBarSeverity: String, Sendable {
    case normal
    case stale
    case warning
    case critical
    case error

    public var linuxStatusColorHex: String? {
        switch self {
        case .warning: "#ff9e64"
        case .critical: "#f7768e"
        case .normal, .stale, .error: nil
        }
    }
}

public struct ClaudexBarPayload: Decodable, Equatable, Sendable {
    public let text: String
    public let tooltip: String
    public let classes: [String]
    public let percentage: Double?
    public let percentageLabel: String?
    public let resetCredits: Double?
    public let updatedAt: String?

    private enum CodingKeys: String, CodingKey {
        case text
        case tooltip
        case classes = "class"
        case percentage
        case percentageLabel
        case resetCredits
        case updatedAt
    }

    public init(text: String, tooltip: String, classes: [String] = [], percentage: Double? = nil, percentageLabel: String? = nil, resetCredits: Double? = nil, updatedAt: String? = nil) {
        self.text = text
        self.tooltip = tooltip
        self.classes = classes
        self.percentage = percentage
        self.percentageLabel = percentageLabel
        self.resetCredits = resetCredits
        self.updatedAt = updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decode(String.self, forKey: .text)
        tooltip = try container.decode(String.self, forKey: .tooltip)
        percentage = try container.decodeIfPresent(Double.self, forKey: .percentage)
        percentageLabel = try container.decodeIfPresent(String.self, forKey: .percentageLabel)
        resetCredits = try container.decodeIfPresent(Double.self, forKey: .resetCredits)
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)

        if let values = try? container.decode([String].self, forKey: .classes) {
            classes = values
        } else if let value = try? container.decode(String.self, forKey: .classes) {
            classes = value.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        } else {
            classes = []
        }
    }

    public var severity: ClaudexBarSeverity {
        if classes.contains("error") { return .error }
        if classes.contains("critical") { return .critical }
        if classes.contains("warning") { return .warning }
        if classes.contains("stale") { return .stale }
        return .normal
    }

    public var macOSDetail: String {
        var lines = tooltip.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if lines.first == "ClaudexBar" {
            lines.removeFirst()
            if lines.first?.allSatisfy({ $0 == "-" }) == true {
                lines.removeFirst()
            }
            while lines.first?.isEmpty == true {
                lines.removeFirst()
            }
        }
        if let creditsIndex = lines.firstIndex(where: { $0.hasPrefix("Free reset credits:") }) {
            lines.remove(at: creditsIndex)
            if creditsIndex > 0, lines[creditsIndex - 1].isEmpty {
                lines.remove(at: creditsIndex - 1)
            }
        }
        if let updatedIndex = lines.firstIndex(where: { $0.hasPrefix("Updated:") }) {
            lines.remove(at: updatedIndex)
            if updatedIndex > 0, lines[updatedIndex - 1].isEmpty {
                lines.remove(at: updatedIndex - 1)
            }
        }
        return lines.joined(separator: "\n")
    }

    public var updatedTimeText: String? {
        guard let updatedAt else { return nil }
        let fractionalFormatter = ISO8601DateFormatter()
        fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fractionalFormatter.date(from: updatedAt) ?? ISO8601DateFormatter().date(from: updatedAt) else {
            return nil
        }
        return date.formatted(date: .omitted, time: .shortened)
    }
}
