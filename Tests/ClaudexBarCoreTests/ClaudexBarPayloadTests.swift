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

@Test func decodesStructuredUsageRows() throws {
    let data = Data(#"{"text":"X → ◉42% ⧖42%","tooltip":"Week 42% · reset 3d\nUpdated: 12:00 PM","class":["provider-grok"],"percentage":42,"percentageLabel":"Weekly","authenticationRequired":false,"usageRows":[{"label":"Cursor Models (Monthly)","percentage":12,"resetText":"14d6h","severity":"normal","pacing":{"expectedPercentage":10}},{"label":"Other Models (Monthly)","percentage":8,"resetText":"14d6h","severity":"normal","pacing":{"expectedPercentage":10}},{"label":"GrokBot (Weekly)","percentage":42,"resetText":"3d","severity":"critical","pacing":{"expectedPercentage":42}}]}"#.utf8)
    let payload = try JSONDecoder().decode(ClaudexBarPayload.self, from: data)

    #expect(payload.classes == ["provider-grok"])
    #expect(payload.percentage == 42)
    #expect(payload.percentageLabel == "Weekly")
    #expect(payload.severity == .normal)
    #expect(payload.authenticationRequired == false)
    #expect(payload.usageRows.map(\.label) == ["Cursor Models (Monthly)", "Other Models (Monthly)", "GrokBot (Weekly)"])
    #expect(payload.usageRows.map(\.percentage) == [12, 8, 42])
    #expect(payload.usageRows.last?.severity == .critical)
    #expect(payload.usageRows[0].pacing?.expectedPercentage == 10)
    #expect(payload.macOSDetail.isEmpty)
}

@Test func decodesGrokAuthenticationRequirementAdditively() throws {
    let requiredData = Data(#"{"text":"⚠ X","tooltip":"Grok sign-in required.","class":["error","provider-grok"],"authenticationRequired":true}"#.utf8)
    let required = try JSONDecoder().decode(ClaudexBarPayload.self, from: requiredData)
    #expect(required.authenticationRequired == true)

    let legacyData = Data(#"{"text":"X","tooltip":"Week 1%","class":["provider-grok"]}"#.utf8)
    let legacy = try JSONDecoder().decode(ClaudexBarPayload.self, from: legacyData)
    #expect(legacy.authenticationRequired == nil)
    #expect(legacy.usageRows.isEmpty)
}

@Test func structuredRowsRemoveDuplicatedQuotaAndCreditDetail() throws {
    let data = Data(#"{"text":"O(1) ↑ ◉21% ⧖13%","tooltip":"Session unavailable\nWeek 21% · critical · reset 6d1h\nCredits 1\nUpdated: 03:51 PM","class":["critical","provider-codex"],"resetCredits":1,"usageRows":[{"label":"Weekly","percentage":21,"resetText":"6d1h","severity":"critical"}]}"#.utf8)
    let payload = try JSONDecoder().decode(ClaudexBarPayload.self, from: data)

    #expect(payload.macOSDetail == "Session unavailable")
}

@Test func providerMetadataMatchesSharedEngine() {
    #expect(ClaudexBarProvider.codex.displayName == "OpenAI")
    #expect(ClaudexBarProvider.claude.displayName == "Anthropic")
    #expect(ClaudexBarProvider.grok.displayName == "SpaceXAI")
    #expect(ClaudexBarProvider.codex.badge == "O")
    #expect(ClaudexBarProvider.claude.badge == "A")
    #expect(ClaudexBarProvider.grok.badge == "S")
    #expect(ClaudexBarProvider.dashboardOrder == [.claude, .codex, .grok])
}

@Test func decodesCombinedProviderPaceForMenuBar() throws {
    let data = Data(#"{"providers":[{"provider":"grok","weeklyPace":39,"payload":{"text":"X","tooltip":"Grok"}},{"provider":"claude","weeklyPace":-1,"payload":{"text":"A","tooltip":"Claude"}},{"provider":"codex","weeklyPace":4,"payload":{"text":"O","tooltip":"Codex"}}]}"#.utf8)
    let aggregate = try JSONDecoder().decode(ClaudexBarAggregatePayload.self, from: data)

    #expect(aggregate.payload(for: .claude)?.paceText == "-1%")
    #expect(aggregate.payload(for: .codex)?.paceText == "+4%")
    #expect(aggregate.payload(for: .grok)?.paceText == "+39%")
    #expect(aggregate.menuBarText == "A -1%  O +4%  S +39%")
}

@Test func combinedProviderPaceOmitsDisconnectedProviders() throws {
    let data = Data(#"{"providers":[{"provider":"claude","weeklyPace":null,"payload":{"text":"A","tooltip":"Claude"}},{"provider":"codex","weeklyPace":4,"payload":{"text":"O","tooltip":"Reconnect","authenticationRequired":true}},{"provider":"grok","weeklyPace":39,"payload":{"text":"X","tooltip":"Grok"}}]}"#.utf8)
    let aggregate = try JSONDecoder().decode(ClaudexBarAggregatePayload.self, from: data)

    #expect(aggregate.payload(for: .codex)?.isConnected == false)
    #expect(aggregate.menuBarText == "A --  S +39%")
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
