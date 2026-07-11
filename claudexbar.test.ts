import { describe, expect, test } from "bun:test";
import { codexUsageToPayload, decodeMacOSKeychainSecret, formatCredits, stampPayload } from "./claudexbar";

describe("decodeMacOSKeychainSecret", () => {
    test("decodes hex-encoded Keychain data", () => {
        expect(decodeMacOSKeychainSecret("7b226f6b223a747275657d\n")).toBe('{"ok":true}');
    });

    test("preserves plain JSON Keychain strings", () => {
        expect(decodeMacOSKeychainSecret('  {"ok":true}\n')).toBe('{"ok":true}');
    });
});

describe("stampPayload", () => {
    test("adds a machine-readable timestamp and subtle tooltip line", () => {
        const payload = stampPayload({ text: "O", tooltip: "Codex" }, Date.UTC(2026, 6, 11, 8, 10));
        expect(payload.updatedAt).toBe("2026-07-11T08:10:00.000Z");
        expect(payload.tooltip).toContain("\n\nUpdated:");
    });
});

describe("codexUsageToPayload", () => {
    test("stamps the live Codex payload used by macOS and Linux", () => {
        const payload = codexUsageToPayload({
            sessionPct: 3,
            weeklyPct: 4,
            sessionResetAt: null,
            weeklyResetAt: null,
            sessionWindowMinutes: null,
            weeklyWindowMinutes: null,
            credits: null,
            resetCredits: 1,
            source: "oauth",
            planType: "plus",
        });
        expect(payload.updatedAt).toBeDefined();
        expect(payload.tooltip).toContain("\n\nUpdated:");
    });
});

describe("formatCredits", () => {
    test("keeps whole reset credits compact", () => {
        expect(formatCredits(1)).toBe("1");
    });

    test("keeps useful fractional precision", () => {
        expect(formatCredits(1.5)).toBe("1.5");
    });
});
