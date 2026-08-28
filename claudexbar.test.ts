import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
    CLAUDE_WEEKLY_WINDOW_MS,
    calcPacing,
    codexUsageToPayload,
    decodeMacOSKeychainSecret,
    formatCredits,
    compactLegacyTooltip,
    parseCodexOAuthUsage,
    stampPayload,
    fetchGrokPayload,
    grokUsageToPayload,
    loginGrok,
    nextProvider,
    parseGrokUsage,
    stripLegacyBarCountdown,
} from "./claudexbar";

describe("Claude weekly pacing", () => {
    test("uses the full seven-day window reported by Anthropic", () => {
        const resetAt = (Date.now() + 67 * 60 * 60 * 1000) / 1000;
        const pacing = calcPacing(2, resetAt, CLAUDE_WEEKLY_WINDOW_MS);

        expect(pacing.timeElapsedPct).toBe(60);
        expect(pacing.status).toBe("97% under");
    });

    test("maps the displayed rounded delta to horizontal, diagonal, and vertical arrows", () => {
        const windowMs = 100 * 60 * 1000;
        const resetAt = (Date.now() + 50 * 60 * 1000) / 1000;
        const cases = [
            { delta: -10, icon: "↓", status: "10% under" },
            { delta: -9, icon: "↘", status: "9% under" },
            { delta: -1, icon: "↘", status: "1% under" },
            { delta: 0, icon: "→", status: "on track" },
            { delta: 1, icon: "↗", status: "1% ahead" },
            { delta: 9, icon: "↗", status: "9% ahead" },
            { delta: 10, icon: "↑", status: "10% ahead" },
        ];

        for (const { delta, icon, status } of cases) {
            const pacing = calcPacing(50 * (1 + delta / 100), resetAt, windowMs);
            expect(pacing).toEqual({ icon, status, devPct: delta, timeElapsedPct: 50 });
        }
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
        expect(payload.tooltip).toContain("\nUpdated:");
    });
});

describe("stripLegacyBarCountdown", () => {
    test("removes the former reset suffix from cached payloads", () => {
        expect(stripLegacyBarCountdown("A ↑ ◉78% ⧖66% 2d9h")).toBe("A ↑ ◉78% ⧖66%");
        expect(stripLegacyBarCountdown("O ↑ ◉60% ⧖37% 4h10m")).toBe("O ↑ ◉60% ⧖37%");
    });
});

describe("compactLegacyTooltip", () => {
    test("compacts the former centred tooltip from cached payloads", () => {
        expect(compactLegacyTooltip("ClaudexBar\n-----------\n\nSession: 2% (on track)\n  Resets in 4h55m\n\nWeekly: 78% (18% ahead)\n  Resets in 2d9h\n\nUpdated: 07:34 PM"))
            .toBe("Session 2% · reset 4h55m\nWeek 78% · reset 2d9h\nUpdated: 07:34 PM");
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
        expect(payload.tooltip).toContain("\nUpdated:");
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
        expect(payload.tooltip).toContain("Session 12%");
        expect(payload.tooltip).toContain("Week unavailable");
        expect(payload.tooltip).not.toContain("Week null%");
    });

    test("keeps reset countdowns in the detail tooltip, not the compact bar text", () => {
        const payload = codexUsageToPayload({
            sessionPct: 12,
            weeklyPct: 34,
            sessionResetAt: (Date.now() + 2 * 60 * 60 * 1000) / 1000,
            weeklyResetAt: (Date.now() + 2 * 24 * 60 * 60 * 1000) / 1000,
            sessionWindowMinutes: 5 * 60,
            weeklyWindowMinutes: 7 * 24 * 60,
            credits: null,
            resetCredits: null,
            source: "oauth",
            planType: "plus",
        });

        expect(payload.text).not.toMatch(/\b\d+d\d+h\b/);
        expect(payload.tooltip).toContain("reset ");
    });

    test("omits normal pacing prose and annotates only the warning window", () => {
        const normal = codexUsageToPayload({
            sessionPct: 12,
            weeklyPct: 34,
            sessionResetAt: (Date.now() + 2 * 60 * 60 * 1000) / 1000,
            weeklyResetAt: (Date.now() + 2 * 24 * 60 * 60 * 1000) / 1000,
            sessionWindowMinutes: 5 * 60,
            weeklyWindowMinutes: 7 * 24 * 60,
            credits: null,
            resetCredits: null,
            source: "oauth",
            planType: "plus",
        });
        expect(normal.tooltip).toMatch(/^Session 12% · reset .+\nWeek 34% · reset .+\nUpdated:/);
        expect(normal.tooltip).not.toMatch(/on track|under|ahead/);

        const warning = codexUsageToPayload({
            sessionPct: 12,
            weeklyPct: 76,
            sessionResetAt: (Date.now() + 2 * 60 * 60 * 1000) / 1000,
            weeklyResetAt: (Date.now() + 1.75 * 24 * 60 * 60 * 1000) / 1000,
            sessionWindowMinutes: 5 * 60,
            weeklyWindowMinutes: 7 * 24 * 60,
            credits: null,
            resetCredits: null,
            source: "oauth",
            planType: "plus",
        });
        expect(warning.class).toEqual(["warning", "provider-codex"]);
        expect(warning.tooltip).toContain("Week 76% · warning · reset ");
        expect(warning.tooltip).not.toContain("Session 12% · warning");
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
        expect(payload.tooltip).toContain("Session unavailable");
        expect(payload.tooltip).toContain("Week 34%");
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
        expect(payload.tooltip).toContain("Week 29% · critical · reset ");
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

describe("Grok provider", () => {
    const usageResponse = {
        usagePercent: 42.4,
        nextResetTimestampUtc: "2026-08-31T00:00:00.000Z",
    };

    test("maps strict Cursor usage into the shared weekly payload and cycle", () => {
        const usage = parseGrokUsage(usageResponse);
        expect(usage.weeklyPct).toBe(42);
        expect(usage.weeklyResetAt).toBe(Date.parse(usageResponse.nextResetTimestampUtc) / 1000);

        const payload = grokUsageToPayload(usage);
        expect(payload.text).toStartWith("G ");
        expect(payload.text).toContain("◉42%");
        expect(payload.class).toContain("provider-grok");
        expect(payload.percentageLabel).toBe("Weekly");
        expect(payload.tooltip).toContain("Week 42%");
        expect(nextProvider("codex")).toBe("claude");
        expect(nextProvider("claude")).toBe("grok");
        expect(nextProvider("grok")).toBe("codex");
    });

    test("opens the explicit PKCE login and stores returned credentials atomically", async () => {
        const directory = await mkdtemp(join(tmpdir(), "claudexbar-grok-login-"));
        const authPath = join(directory, "grok-auth.json");
        let openedUrl = "";
        let polledUrl = "";
        let now = 0;
        let polls = 0;

        try {
            await loginGrok({
                authPath,
                uuid: () => "test-uuid",
                verifier: () => "test-verifier",
                nowMs: () => now,
                sleep: async (ms) => { now += ms; },
                openBrowser: async (url) => { openedUrl = url; },
                fetchImpl: async (input) => {
                    polledUrl = String(input);
                    polls += 1;
                    return polls == 1
                        ? new Response(null, { status: 202 })
                        : Response.json({
                            accessToken: "test-access-token",
                            refreshToken: "test-refresh-token",
                        });
                },
            });

            const loginUrl = new URL(openedUrl);
            expect(`${loginUrl.origin}${loginUrl.pathname}`).toBe("https://cursor.com/loginDeepControl");
            expect(loginUrl.searchParams.get("challenge")).toBeDefined();
            expect(loginUrl.searchParams.get("uuid")).toBe("test-uuid");
            expect(loginUrl.searchParams.get("mode")).toBe("login");
            expect(loginUrl.searchParams.get("redirectTarget")).toBe("sand");
            expect(loginUrl.searchParams.get("supportsSelectedTeamLogin")).toBe("true");
            expect(polledUrl).toBe("https://api2.cursor.sh/auth/poll?uuid=test-uuid&verifier=test-verifier");
            expect(await readFile(authPath, "utf8")).toBe(
                JSON.stringify({
                    accessToken: "test-access-token",
                    refreshToken: "test-refresh-token",
                }),
            );
            expect((await stat(authPath)).mode & 0o777).toBe(0o600);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("posts the Connect request with ClaudexBar-owned auth and redacts output", async () => {
        const directory = await mkdtemp(join(tmpdir(), "claudexbar-grok-usage-"));
        const authPath = join(directory, "grok-auth.json");
        const sentinel = "test-token-must-not-leak";
        await writeFile(authPath, JSON.stringify({
            accessToken: sentinel,
            refreshToken: "test-refresh-token",
        }));

        try {
            let requestUrl = "";
            let requestInit: RequestInit | undefined;
            const payload = await fetchGrokPayload({
                authPath,
                fetchImpl: async (input, init) => {
                    requestUrl = String(input);
                    requestInit = init;
                    return Response.json(usageResponse);
                },
            });
            const headers = new Headers(requestInit?.headers);
            expect(requestUrl).toBe("https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus");
            expect(requestInit?.method).toBe("POST");
            expect(requestInit?.body).toBe("{}");
            expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
            expect(headers.get("authorization")).toBe(`Bearer ${sentinel}`);
            expect(headers.get("content-type")).toBe("application/json");
            expect(headers.get("connect-protocol-version")).toBe("1");
            expect(JSON.stringify(payload)).not.toContain(sentinel);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("fails closed on missing auth, unauthorized auth, and malformed usage", async () => {
        const directory = await mkdtemp(join(tmpdir(), "claudexbar-grok-errors-"));
        const authPath = join(directory, "grok-auth.json");
        try {
            await expect(fetchGrokPayload({ authPath }))
                .rejects.toThrow("Grok sign-in required. Sign in or reconnect Grok.");
            await writeFile(authPath, JSON.stringify({
                accessToken: "test-access-token",
                refreshToken: "test-refresh-token",
            }));
            await expect(fetchGrokPayload({
                authPath,
                fetchImpl: async () => new Response(null, { status: 401 }),
            })).rejects.toThrow("Grok sign-in required. Sign in or reconnect Grok.");
            await expect(fetchGrokPayload({
                authPath,
                fetchImpl: async () => Response.json({
                    usagePercent: "42",
                    nextResetTimestampUtc: usageResponse.nextResetTimestampUtc,
                }),
            })).rejects.toThrow("Invalid Grok usage response");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
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
