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
    parseCursorMonthlyUsage,
    parseGrokUsage,
    renderGrokPayload,
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
        expect(payload.usageRows).toMatchObject([
            { label: "Session", percentage: 3, resetText: "n/a", severity: "critical" },
            { label: "Weekly", percentage: 4, resetText: "n/a", severity: "critical" },
        ]);
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
        expect(payload.usageRows).toHaveLength(1);
        expect(payload.usageRows[0]).toMatchObject({
            label: "Session",
            percentage: 12,
            severity: "critical",
        });
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

    test("colors each row orange below ten percent over pace and red at ten percent", () => {
        const now = Date.now();
        const payload = (sessionPct: number | null, weeklyPct: number) => codexUsageToPayload({
            sessionPct,
            weeklyPct,
            sessionResetAt: sessionPct == null ? null : (now + 50 * 60 * 1000) / 1000,
            weeklyResetAt: (now + 50 * 60 * 1000) / 1000,
            sessionWindowMinutes: sessionPct == null ? null : 100,
            weeklyWindowMinutes: 100,
            credits: null,
            resetCredits: null,
            source: "oauth",
            planType: "plus",
        });

        expect(payload(null, 50).class).toEqual(["provider-codex"]);
        expect(payload(null, 54).class).toEqual(["warning", "provider-codex"]);
        expect(payload(null, 55).class).toEqual(["critical", "provider-codex"]);

        const independentRows = payload(54, 50);
        expect(independentRows.usageRows.map((row) => row.severity)).toEqual(["warning", "normal"]);
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

    test("keeps near-exhausted usage orange when it is under ten percent over pace", () => {
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

        expect(payload.class).toEqual(["warning", "provider-codex"]);
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
    const monthlyUsageResponse = {
        planUsage: {
            autoPercentUsed: 0.10333333333333333,
            apiPercentUsed: 0.172,
        },
        billingCycleStart: "1785456000000",
        billingCycleEnd: "1788134400000",
    };



    test("maps strict Cursor usage into the shared weekly payload and cycle", () => {
        const usage = parseGrokUsage(usageResponse);
        expect(usage.weeklyPct).toBe(42);
        expect(usage.weeklyResetAt).toBe(Date.parse(usageResponse.nextResetTimestampUtc) / 1000);

        const payload = grokUsageToPayload(usage);
        expect(payload.text).toStartWith("X ");
        expect(payload.text).toContain("◉42%");
        expect(payload.class).toContain("provider-grok");
        expect(payload.percentageLabel).toBe("Weekly");
        expect(payload.authenticationRequired).toBe(false);
        expect(payload.tooltip).toContain("Week 42%");
        expect(nextProvider("codex")).toBe("claude");
        expect(nextProvider("claude")).toBe("grok");
        expect(nextProvider("grok")).toBe("codex");

        const monthlyUsage = parseCursorMonthlyUsage(monthlyUsageResponse);
        const enrichedPayload = grokUsageToPayload(usage, monthlyUsage);
        expect(enrichedPayload.usageRows.map((row) => ({
            label: row.label,
            percentage: row.percentage,
            severity: row.severity,
        }))).toEqual([
            { label: "Cursor Models (Monthly)", percentage: 1, severity: "normal" },
            { label: "Other Models (Monthly)", percentage: 1, severity: "normal" },
            { label: "GrokBot (Weekly)", percentage: 42, severity: "normal" },
        ]);
        expect(enrichedPayload.text).toBe(payload.text);
        expect(enrichedPayload.percentageLabel).toBe("Weekly");
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
            const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
            const payload = await fetchGrokPayload({
                authPath,
                fetchImpl: async (input, init) => {
                    const url = String(input);
                    requests.push({ url, init });
                    return url.endsWith("/GetCurrentPeriodUsage")
                        ? Response.json(monthlyUsageResponse)
                        : Response.json(usageResponse);
                },
            });
            expect(requests.map((request) => request.url)).toEqual([
                "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus",
                "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
            ]);
            const requestInit = requests[0]?.init;
            const headers = new Headers(requestInit?.headers);
            expect(requestInit?.method).toBe("POST");
            expect(requestInit?.body).toBe("{}");
            expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
            expect(headers.get("authorization")).toBe(`Bearer ${sentinel}`);
            expect(headers.get("content-type")).toBe("application/json");
            expect(headers.get("connect-protocol-version")).toBe("1");
            expect(JSON.stringify(payload)).not.toContain(sentinel);
            expect(payload.authenticationRequired).toBe(false);
            expect(payload.usageRows.map((row) => row.percentage)).toEqual([1, 1, 42]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("keeps weekly Grok usage when optional monthly usage is unavailable", async () => {
        const directory = await mkdtemp(join(tmpdir(), "claudexbar-grok-monthly-"));
        const authPath = join(directory, "grok-auth.json");
        await writeFile(authPath, JSON.stringify({
            accessToken: "test-access-token",
            refreshToken: "test-refresh-token",
        }));

        try {
            const payload = await fetchGrokPayload({
                authPath,
                fetchImpl: async (input) => String(input).endsWith("/GetCurrentPeriodUsage")
                    ? new Response(null, { status: 401 })
                    : Response.json(usageResponse),
            });
            expect(payload.text).toContain("◉42%");
            expect(payload.percentageLabel).toBe("Weekly");
            expect(payload.authenticationRequired).toBe(false);
            expect(payload.usageRows.map((row) => row.label)).toEqual(["GrokBot (Weekly)"]);
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

    test("labels only missing or rejected Grok credentials as sign-in required", async () => {
        const directory = await mkdtemp(join(tmpdir(), "claudexbar-grok-auth-state-"));
        const authPath = join(directory, "grok-auth.json");
        try {
            const missing = await renderGrokPayload({ authPath });
            expect(missing.authenticationRequired).toBe(true);

            await writeFile(authPath, JSON.stringify({
                accessToken: "test-access-token",
                refreshToken: "test-refresh-token",
            }));
            const unauthorized = await renderGrokPayload({
                authPath,
                fetchImpl: async () => new Response(null, { status: 401 }),
            });
            expect(unauthorized.authenticationRequired).toBe(true);

            const unavailable = await renderGrokPayload({
                authPath,
                fetchImpl: async () => new Response(null, { status: 503 }),
            });
            expect(unavailable.authenticationRequired).toBeUndefined();

            const malformed = await renderGrokPayload({
                authPath,
                fetchImpl: async () => Response.json({
                    usagePercent: "42",
                    nextResetTimestampUtc: usageResponse.nextResetTimestampUtc,
                }),
            });
            expect(malformed.authenticationRequired).toBeUndefined();
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
