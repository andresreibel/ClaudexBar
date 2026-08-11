import Foundation
import Testing
@testable import ClaudexBarCore

@Test func decodesWaybarStringClass() throws {
    let data = Data(#"{"text":"O(1) → 42%","tooltip":"Codex","class":"warning provider-codex","percentage":12,"percentageLabel":"Session","resetCredits":1,"updatedAt":"2026-07-11T08:10:00.000Z"}"#.utf8)
    let payload = try JSONDecoder().decode(ClaudexBarPayload.self, from: data)

    #expect(payload.text == "O(1) → 42%")
    #expect(payload.classes == ["warning", "provider-codex"])
    #expect(payload.percentage == 12)
    #expect(payload.percentageLabel == "Session")
    #expect(payload.resetCredits == 1)
    #expect(payload.updatedAt == "2026-07-11T08:10:00.000Z")
    #expect(payload.updatedTimeText != nil)
    #expect(payload.severity == .warning)
}

@Test func decodesWaybarArrayClassAndSeverityPriority() throws {
    let data = Data(#"{"text":"A ↑ 95%","tooltip":"Claude","class":["stale","critical","provider-claude"]}"#.utf8)
    let payload = try JSONDecoder().decode(ClaudexBarPayload.self, from: data)

    #expect(payload.classes == ["stale", "critical", "provider-claude"])
    #expect(payload.severity == .critical)
}

@Test func providerMetadataMatchesSharedEngine() {
    #expect(ClaudexBarProvider.codex.badge == "O")
    #expect(ClaudexBarProvider.claude.badge == "A")
}

@Test func menuBarColorsMatchLinuxWaybar() {
    #expect(ClaudexBarSeverity.warning.linuxStatusColorHex == "#ff9e64")
    #expect(ClaudexBarSeverity.critical.linuxStatusColorHex == "#f7768e")
    #expect(ClaudexBarSeverity.normal.linuxStatusColorHex == nil)
    #expect(ClaudexBarSeverity.stale.linuxStatusColorHex == nil)
    #expect(ClaudexBarSeverity.error.linuxStatusColorHex == nil)
    #expect(ClaudexBarSeverity.warning.macOSStatusColorHex == "#ff9e64")
    #expect(ClaudexBarSeverity.critical.macOSStatusColorHex == "#ff453a")
    #expect(ClaudexBarSeverity.isStatusAccentSymbol("↑"))
    #expect(!ClaudexBarSeverity.isStatusAccentSymbol("◉"))
    #expect(!ClaudexBarSeverity.isStatusAccentSymbol("⧖"))
    #expect(!ClaudexBarSeverity.isStatusAccentSymbol("O"))
    #expect(!ClaudexBarSeverity.isStatusAccentSymbol("1"))
}

@Test func removesDuplicatedHeaderFromMacOSDetailOnly() {
    let payload = ClaudexBarPayload(
        text: "O(1)",
        tooltip: "ClaudexBar\n-----------\nProvider: Codex (oauth)\n\nSession: 1%\n\nFree reset credits: 1\n\nUpdated: 15:10"
    )

    #expect(payload.macOSDetail == "Provider: Codex (oauth)\n\nSession: 1%")
    #expect(payload.tooltip.hasPrefix("ClaudexBar\n-----------"))
}

@Test func keepsWeeklyUsageInMacOSDetail() {
    let payload = ClaudexBarPayload(
        text: "O(1) ↑ ◉4% ⧖2% 6d21h",
        tooltip: "ClaudexBar\n-----------\nProvider: Codex (oauth)\n\nSession: 26% (52% under)\n  Resets in 2h17m\n\nWeekly: 4% (100% ahead)\n  Resets in 6d21h\n\nFree reset credits: 1\n\nUpdated: 03:45 PM"
    )

    #expect(payload.macOSDetail.contains("Weekly: 4% (100% ahead)"))
    #expect(payload.macOSDetail.contains("Resets in 6d21h"))
}
