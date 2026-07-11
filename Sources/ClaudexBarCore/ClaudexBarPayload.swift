import Foundation

public enum ClaudexBarProvider: String, CaseIterable, Codable, Sendable {
    case codex
    case claude

    public var displayName: String {
        switch self {
        case .codex: "Codex"
        case .claude: "Claude"
        }
    }

    public var badge: String {
        switch self {
        case .codex: "O"
        case .claude: "A"
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

    public var macOSStatusColorHex: String? {
        switch self {
        case .warning: "#ff9e64"
        case .critical: "#ff453a"
        case .normal, .stale, .error: nil
        }
    }

    public static func isStatusAccentSymbol(_ character: Character) -> Bool {
        "↑↗→↘↓◉⧖".contains(character)
    }
}

public struct ClaudexBarPayload: Decodable, Equatable, Sendable {
    public let text: String
    public let tooltip: String
    public let classes: [String]
    public let percentage: Double?
    public let resetCredits: Double?

    private enum CodingKeys: String, CodingKey {
        case text
        case tooltip
        case classes = "class"
        case percentage
        case resetCredits
    }

    public init(text: String, tooltip: String, classes: [String] = [], percentage: Double? = nil, resetCredits: Double? = nil) {
        self.text = text
        self.tooltip = tooltip
        self.classes = classes
        self.percentage = percentage
        self.resetCredits = resetCredits
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decode(String.self, forKey: .text)
        tooltip = try container.decode(String.self, forKey: .tooltip)
        percentage = try container.decodeIfPresent(Double.self, forKey: .percentage)
        resetCredits = try container.decodeIfPresent(Double.self, forKey: .resetCredits)

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
        return lines.joined(separator: "\n")
    }
}
