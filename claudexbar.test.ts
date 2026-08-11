import { describe, expect, test } from "bun:test";
import {
    CLAUDE_WEEKLY_WINDOW_MS,
    calcPacing,
    codexUsageToPayload,
    decodeMacOSKeychainSecret,
    formatCredits,
    parseCodexOAuthUsage,
    stampPayload,
} from "./claudexbar";

describe("Claude weekly pacing", () => {
    test("uses the full seven-day window reported by Anthropic", () => {
        const resetAt = (Date.now() + 67 * 60 * 60 * 1000) / 1000;
        const pacing = calcPacing(2, resetAt, CLAUDE_WEEKLY_WINDOW_MS);

        expect(pacing.timeElapsedPct).toBe(60);
        expect(pacing.status).toBe("97% under");
    });
});

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
        expect(payload.tooltip).not.toContain("Provider:");
    });

    test("renders the session window when weekly usage is unavailable", () => {
        const usage = parseCodexOAuthUsage({
            rate_limit: {
                primary_window: {
                    used_percent: 12,
                    limit_window_seconds: 18_000,
                    reset_at: 1_800_000_000,
                },
                secondary_window: null,
            },
        });

        const payload = codexUsageToPayload(usage);

        expect(payload.text).toContain("◉12%");
        expect(payload.percentageLabel).toBe("Session");
        expect(payload.tooltip).toContain("Session: 12%");
        expect(payload.tooltip).toContain("Weekly: currently unavailable");
        expect(payload.tooltip).not.toContain("Weekly: null%");
    });

    test("recognizes a lone seven-day primary window as weekly usage", () => {
        const usage = parseCodexOAuthUsage({
            rate_limit: {
                primary_window: {
                    used_percent: 34,
                    limit_window_seconds: 604_800,
                    reset_at: 1_800_000_000,
                },
                secondary_window: null,
            },
        });

        const payload = codexUsageToPayload(usage);

        expect(payload.text).toContain("◉34%");
        expect(payload.percentageLabel).toBe("Weekly");
        expect(payload.tooltip).toContain("Session: currently unavailable");
        expect(payload.tooltip).toContain("Weekly: 34%");
    });

    test("marks materially ahead-of-pace weekly usage critical", () => {
        const payload = codexUsageToPayload({
            sessionPct: null,
            weeklyPct: 29,
            sessionResetAt: null,
            weeklyResetAt: (Date.now() + 5.25 * 24 * 60 * 60 * 1000) / 1000,
            sessionWindowMinutes: null,
            weeklyWindowMinutes: 7 * 24 * 60,
            credits: null,
            resetCredits: 0,
            source: "oauth",
            planType: "plus",
        });

        expect(payload.class).toEqual(["critical", "provider-codex"]);
        expect(payload.percentageLabel).toBe("Weekly");
    });

    test("keeps near-exhausted weekly usage critical", () => {
        const payload = codexUsageToPayload({
            sessionPct: null,
            weeklyPct: 90,
            sessionResetAt: null,
            weeklyResetAt: (Date.now() + 24 * 60 * 60 * 1000) / 1000,
            sessionWindowMinutes: null,
            weeklyWindowMinutes: 7 * 24 * 60,
            credits: null,
            resetCredits: 0,
            source: "oauth",
            planType: "plus",
        });

        expect(payload.class).toEqual(["critical", "provider-codex"]);
    });

    test("rejects OAuth usage when every window is unavailable", () => {
        expect(() => parseCodexOAuthUsage({ rate_limit: {} })).toThrow("OAuth payload missing rate-limit windows");
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
