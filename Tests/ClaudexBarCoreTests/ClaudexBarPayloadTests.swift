import Foundation
import Testing
@testable import ClaudexBarCore

@Test func decodesWaybarStringClass() throws {
    let data = Data(#"{"text":"O(1) → 42%","tooltip":"Codex","class":"warning provider-codex","percentage":12,"resetCredits":1}"#.utf8)
    let payload = try JSONDecoder().decode(ClaudexBarPayload.self, from: data)

    #expect(payload.text == "O(1) → 42%")
    #expect(payload.classes == ["warning", "provider-codex"])
    #expect(payload.percentage == 12)
    #expect(payload.resetCredits == 1)
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

@Test func removesDuplicatedHeaderFromMacOSDetailOnly() {
    let payload = ClaudexBarPayload(
        text: "O(1)",
        tooltip: "ClaudexBar\n-----------\nProvider: Codex (oauth)\n\nSession: 1%\n\nFree reset credits: 1"
    )

    #expect(payload.macOSDetail == "Provider: Codex (oauth)\n\nSession: 1%")
    #expect(payload.tooltip.hasPrefix("ClaudexBar\n-----------"))
}
