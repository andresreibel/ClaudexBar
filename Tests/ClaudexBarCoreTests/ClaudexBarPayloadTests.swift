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

@Test func decodesGrokWeeklyPayload() throws {
    let data = Data(#"{"text":"G → ◉42% ⧖42%","tooltip":"Week 42% · reset 3d\nUpdated: 12:00 PM","class":["provider-grok"],"percentage":42,"percentageLabel":"Weekly","authenticationRequired":false}"#.utf8)
    let payload = try JSONDecoder().decode(ClaudexBarPayload.self, from: data)

    #expect(payload.classes == ["provider-grok"])
    #expect(payload.percentage == 42)
    #expect(payload.percentageLabel == "Weekly")
    #expect(payload.severity == .normal)
    #expect(payload.authenticationRequired == false)
}

@Test func decodesGrokAuthenticationRequirementAdditively() throws {
    let requiredData = Data(#"{"text":"⚠ G","tooltip":"Grok sign-in required.","class":["error","provider-grok"],"authenticationRequired":true}"#.utf8)
    let required = try JSONDecoder().decode(ClaudexBarPayload.self, from: requiredData)
    #expect(required.authenticationRequired == true)

    let legacyData = Data(#"{"text":"G","tooltip":"Week 1%","class":["provider-grok"]}"#.utf8)
    let legacy = try JSONDecoder().decode(ClaudexBarPayload.self, from: legacyData)
    #expect(legacy.authenticationRequired == nil)
}

@Test func providerMetadataMatchesSharedEngine() {
    #expect(ClaudexBarProvider.codex.displayName == "OpenAI")
    #expect(ClaudexBarProvider.claude.displayName == "Anthropic")
    #expect(ClaudexBarProvider.grok.displayName == "SpaceXAI")
    #expect(ClaudexBarProvider.codex.badge == "O")
    #expect(ClaudexBarProvider.claude.badge == "A")
    #expect(ClaudexBarProvider.grok.badge == "G")
}

@Test func linuxStatusColorsMatchWaybar() {
    #expect(ClaudexBarSeverity.warning.linuxStatusColorHex == "#ff9e64")
    #expect(ClaudexBarSeverity.critical.linuxStatusColorHex == "#f7768e")
    #expect(ClaudexBarSeverity.normal.linuxStatusColorHex == nil)
    #expect(ClaudexBarSeverity.stale.linuxStatusColorHex == nil)
    #expect(ClaudexBarSeverity.error.linuxStatusColorHex == nil)
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
