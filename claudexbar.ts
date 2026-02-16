#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

const HOME = homedir();
const STATE_DIR = `${HOME}/.codex/claudexbar`;
const PROVIDER_STATE_PATH = `${STATE_DIR}/provider`;

const CLAUDE_PROVIDER = "claude";
const CODEX_PROVIDER = "codex";

const CODEX_AUTH_PATH = `${HOME}/.codex/auth.json`;
const CODEX_CONFIG_PATH = `${HOME}/.codex/config.toml`;

const CLAUDE_CREDS_PATH = `${HOME}/.claude/.credentials.json`;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_REFRESH_BUFFER_MS = 5 * 60 * 1000;

type Provider = typeof CLAUDE_PROVIDER | typeof CODEX_PROVIDER;

type Args = {
    provider: Provider | null;
    toggleProvider: boolean;
};

type WaybarPayload = {
    text: string;
    tooltip: string;
    class?: string | string[];
    percentage?: number;
};

type SpawnResult = {
    stdout: string;
    stderr: string;
    code: number;
};

type Pacing = {
    icon: string;
    status: string;
    devPct: number;
    timeElapsedPct: number;
};

type CodexUsageSnapshot = {
    sessionPct: number;
    weeklyPct: number;
    sessionResetAt: number | null;
    weeklyResetAt: number | null;
    sessionWindowMinutes: number | null;
    weeklyWindowMinutes: number | null;
    credits: number | null;
    source: "oauth" | "rpc";
    planType: string | null;
};

type CodexAuth = {
    raw: Record<string, unknown>;
    mode: "oauth" | "apikey";
    accessToken: string;
    refreshToken: string | null;
    accountId: string | null;
    lastRefresh: Date | null;
};

type JSONRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JSONRecord {
    return typeof value == "object" && value != null && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
    if (typeof value == "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value == "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function toStringValue(value: unknown): string | null {
    return typeof value == "string" && value.trim().length > 0 ? value : null;
}

function readNestedRecord(root: JSONRecord, ...path: string[]): JSONRecord | null {
    let current: unknown = root;
    for (const key of path) {
        if (!isRecord(current) || !(key in current)) {
            return null;
        }
        current = current[key];
    }
    return isRecord(current) ? current : null;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function parseArgs(argv: string[]): Args {
    let provider: Provider | null = null;
    let toggleProvider = false;

    for (let idx = 0; idx < argv.length; idx += 1) {
        const arg = argv[idx];
        if (arg == "--toggle") {
            toggleProvider = true;
            continue;
        }
        if (arg == "--provider") {
            const next = argv[idx + 1];
            if (next == CLAUDE_PROVIDER || next == CODEX_PROVIDER) {
                provider = next;
                idx += 1;
            }
            continue;
        }
    }

    return {
        provider,
        toggleProvider,
    };
}

async function ensureStateDir(): Promise<void> {
    await mkdir(STATE_DIR, { recursive: true });
}

async function readProvider(): Promise<Provider> {
    try {
        const value = (await readFile(PROVIDER_STATE_PATH, "utf8")).trim();
        if (value == CLAUDE_PROVIDER || value == CODEX_PROVIDER) {
            return value;
        }
    } catch {
        // ignore
    }
    return CODEX_PROVIDER;
}

async function writeProvider(provider: Provider): Promise<void> {
    await ensureStateDir();
    await writeFile(PROVIDER_STATE_PATH, provider + "\n", "utf8");
}

function nextProvider(provider: Provider): Provider {
    return provider == CODEX_PROVIDER ? CLAUDE_PROVIDER : CODEX_PROVIDER;
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";

        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`${command} timed out`));
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });

        child.on("error", (err: Error) => {
            clearTimeout(timer);
            reject(err);
        });

        child.on("close", (code: number | null) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code: code ?? 1 });
        });
    });
}

async function refreshWaybar(): Promise<void> {
    try {
        await runCommand("pkill", ["-RTMIN+11", "waybar"], 2_000);
    } catch {
        // No-op when waybar is not running.
    }
}

function mergeClasses(...values: Array<string | string[] | undefined>): string[] | undefined {
    const merged: string[] = [];

    for (const value of values) {
        if (!value) {
            continue;
        }
        const entries = Array.isArray(value) ? value : value.split(/\s+/);
        for (const entry of entries) {
            const trimmed = entry.trim();
            if (!trimmed || merged.includes(trimmed)) {
                continue;
            }
            merged.push(trimmed);
        }
    }

    return merged.length > 0 ? merged : undefined;
}

function addProviderBadge(text: string, badge: "A" | "O"): string {
    const trimmed = text.trim();
    if (!trimmed) {
        return badge;
    }

    const arrows = new Set(["↑", "↗", "→", "↘", "↓"]);
    const chars = Array.from(trimmed);
    if (chars.length > 0 && arrows.has(chars[0] ?? "")) {
        const rest = chars.slice(1).join("").trimStart();
        return `${badge} ${chars[0]} ${rest}`.trim();
    }

    return `${badge} ${trimmed}`;
}

function formatCountdown(resetAtEpochSeconds: number | null): string {
    if (resetAtEpochSeconds == null) {
        return "n/a";
    }
    const ms = resetAtEpochSeconds * 1000 - Date.now();
    if (ms <= 0) {
        return "now";
    }
    const totalMinutes = Math.floor(ms / 60_000);
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) {
        return `${days}d${hours}h`;
    }
    return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

function calcPacing(usagePct: number, resetAtEpochSeconds: number | null, windowMs: number | null): Pacing {
    if (resetAtEpochSeconds == null || windowMs == null || windowMs <= 0) {
        return { icon: "→", status: "unknown pace", devPct: 0, timeElapsedPct: 0 };
    }

    const resetAtMs = resetAtEpochSeconds * 1000;
    const startAtMs = resetAtMs - windowMs;
    const elapsedPct = clamp(Math.round(((Date.now() - startAtMs) / windowMs) * 100), 0, 100);
    const pacing = elapsedPct > 0 ? usagePct / elapsedPct : 0;

    if (pacing > 1.10) {
        const delta = Math.round((pacing - 1) * 100);
        return { icon: "↑", status: `${delta}% ahead`, devPct: delta, timeElapsedPct: elapsedPct };
    }
    if (pacing > 1.05) {
        const delta = Math.round((pacing - 1) * 100);
        return { icon: "↗", status: `${delta}% ahead`, devPct: delta, timeElapsedPct: elapsedPct };
    }
    if (pacing < 0.90) {
        const delta = Math.round((1 - pacing) * 100);
        return { icon: "↓", status: `${delta}% under`, devPct: -delta, timeElapsedPct: elapsedPct };
    }
    if (pacing < 0.95) {
        const delta = Math.round((1 - pacing) * 100);
        return { icon: "↘", status: `${delta}% under`, devPct: -delta, timeElapsedPct: elapsedPct };
    }

    return { icon: "→", status: "on track", devPct: 0, timeElapsedPct: elapsedPct };
}

function deriveCssClass(weeklyPct: number, weeklyPacing: Pacing): string {
    const elapsed = weeklyPacing.timeElapsedPct > 0 ? weeklyPacing.timeElapsedPct : 1;
    const pace = weeklyPct / elapsed;
    if (pace > 1.10 || weeklyPct >= 90) {
        return "critical";
    }
    if (pace > 1.05 || weeklyPct >= 75) {
        return "warning";
    }
    if (pace < 0.95 && pace >= 0.90) {
        return "easy";
    }
    return "";
}

function parseIsoDate(value: string | null): Date | null {
    if (!value) {
        return null;
    }
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) {
        return null;
    }
    return new Date(timestamp);
}

function needsRefresh(lastRefresh: Date | null): boolean {
    if (!lastRefresh) {
        return true;
    }
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    return Date.now() - lastRefresh.getTime() > eightDaysMs;
}

async function loadCodexAuth(): Promise<CodexAuth> {
    let rawText: string;
    try {
        rawText = await readFile(CODEX_AUTH_PATH, "utf8");
    } catch {
        throw new Error("Missing ~/.codex/auth.json. Run: codex login");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        throw new Error("Invalid ~/.codex/auth.json JSON");
    }
    if (!isRecord(parsed)) {
        throw new Error("Unexpected ~/.codex/auth.json shape");
    }

    const apiKey = toStringValue(parsed.OPENAI_API_KEY);
    if (apiKey) {
        return {
            raw: parsed,
            mode: "apikey",
            accessToken: apiKey,
            refreshToken: null,
            accountId: null,
            lastRefresh: null,
        };
    }

    const tokens = readNestedRecord(parsed, "tokens");
    if (!tokens) {
        throw new Error("No tokens found in ~/.codex/auth.json");
    }

    const accessToken = toStringValue(tokens.access_token);
    const refreshToken = toStringValue(tokens.refresh_token);
    const accountId = toStringValue(tokens.account_id);
    const lastRefresh = parseIsoDate(toStringValue(parsed.last_refresh));

    if (!accessToken) {
        throw new Error("Missing Codex access token. Run: codex login");
    }

    return {
        raw: parsed,
        mode: "oauth",
        accessToken,
        refreshToken,
        accountId,
        lastRefresh,
    };
}

async function saveCodexAuth(raw: JSONRecord): Promise<void> {
    await writeFile(CODEX_AUTH_PATH, JSON.stringify(raw, null, 2), "utf8");
}

async function maybeRefreshCodexToken(auth: CodexAuth): Promise<CodexAuth> {
    if (auth.mode != "oauth") {
        return auth;
    }
    if (!auth.refreshToken || !needsRefresh(auth.lastRefresh)) {
        return auth;
    }

    const response = await fetch("https://auth.openai.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
            grant_type: "refresh_token",
            refresh_token: auth.refreshToken,
            scope: "openid profile email",
        }),
    });

    if (!response.ok) {
        return auth;
    }

    const payload = await response.json();
    if (!isRecord(payload)) {
        return auth;
    }

    const accessToken = toStringValue(payload.access_token) ?? auth.accessToken;
    const refreshToken = toStringValue(payload.refresh_token) ?? auth.refreshToken;

    const raw = auth.raw;
    const tokens = readNestedRecord(raw, "tokens");
    if (!tokens) {
        return auth;
    }

    tokens.access_token = accessToken;
    tokens.refresh_token = refreshToken;
    raw.last_refresh = new Date().toISOString();
    await saveCodexAuth(raw);

    return {
        ...auth,
        accessToken,
        refreshToken,
        lastRefresh: new Date(),
    };
}

async function resolveCodexBaseUrl(): Promise<string> {
    let configContents = "";
    try {
        configContents = await readFile(CODEX_CONFIG_PATH, "utf8");
    } catch {
        return "https://chatgpt.com/backend-api";
    }

    const lines = configContents.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.split("#", 1)[0]?.trim() ?? "";
        if (!line.startsWith("chatgpt_base_url")) {
            continue;
        }
        const parts = line.split("=", 2);
        if (parts.length != 2) {
            continue;
        }
        const value = parts[1]?.trim().replace(/^['\"]/, "").replace(/['\"]$/, "") ?? "";
        if (!value) {
            continue;
        }

        let normalized = value.replace(/\/+$/, "");
        if ((normalized.startsWith("https://chatgpt.com") || normalized.startsWith("https://chat.openai.com")) &&
            !normalized.includes("/backend-api")) {
            normalized += "/backend-api";
        }
        return normalized;
    }

    return "https://chatgpt.com/backend-api";
}

function parseCodexOAuthUsage(raw: unknown): CodexUsageSnapshot {
    if (!isRecord(raw)) {
        throw new Error("Codex OAuth response is not an object");
    }

    const rateLimit = readNestedRecord(raw, "rate_limit");
    const primary = rateLimit ? readNestedRecord(rateLimit, "primary_window") : null;
    const secondary = rateLimit ? readNestedRecord(rateLimit, "secondary_window") : null;

    const sessionPct = toNumber(primary?.used_percent) ?? null;
    const weeklyPct = toNumber(secondary?.used_percent) ?? null;
    const sessionResetAt = toNumber(primary?.reset_at);
    const weeklyResetAt = toNumber(secondary?.reset_at);
    const sessionWindowSeconds = toNumber(primary?.limit_window_seconds);
    const weeklyWindowSeconds = toNumber(secondary?.limit_window_seconds);

    if (sessionPct == null || weeklyPct == null) {
        throw new Error("OAuth payload missing rate-limit windows");
    }

    const creditsNode = readNestedRecord(raw, "credits");
    const credits = toNumber(creditsNode?.balance);
    const planType = toStringValue(raw.plan_type);

    return {
        sessionPct: clamp(Math.round(sessionPct), 0, 100),
        weeklyPct: clamp(Math.round(weeklyPct), 0, 100),
        sessionResetAt: sessionResetAt == null ? null : Math.round(sessionResetAt),
        weeklyResetAt: weeklyResetAt == null ? null : Math.round(weeklyResetAt),
        sessionWindowMinutes: sessionWindowSeconds == null ? null : Math.max(1, Math.round(sessionWindowSeconds / 60)),
        weeklyWindowMinutes: weeklyWindowSeconds == null ? null : Math.max(1, Math.round(weeklyWindowSeconds / 60)),
        credits,
        source: "oauth",
        planType,
    };
}

async function fetchCodexUsageViaOAuth(): Promise<CodexUsageSnapshot> {
    const loaded = await loadCodexAuth();
    const auth = await maybeRefreshCodexToken(loaded);
    const baseUrl = await resolveCodexBaseUrl();
    const path = baseUrl.includes("/backend-api") ? "/wham/usage" : "/api/codex/usage";

    const headers = new Headers();
    headers.set("Authorization", `Bearer ${auth.accessToken}`);
    headers.set("Accept", "application/json");
    headers.set("User-Agent", "ClaudexBar");
    if (auth.accountId) {
        headers.set("ChatGPT-Account-Id", auth.accountId);
    }

    const response = await fetch(`${baseUrl}${path}`, { headers });
    if (!response.ok) {
        throw new Error(`OAuth API ${response.status}`);
    }

    const body = await response.json();
    return parseCodexOAuthUsage(body);
}

async function fetchCodexUsageViaRpc(): Promise<CodexUsageSnapshot> {
    const rateLimitResult = await new Promise<JSONRecord>((resolve, reject) => {
        const child = spawn("codex", ["-s", "read-only", "-a", "untrusted", "app-server"], {
            stdio: ["pipe", "pipe", "pipe"],
        });

        const timeout = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error("RPC timeout"));
        }, 8_000);

        let stdoutBuffer = "";
        let stderrBuffer = "";
        let settled = false;

        function cleanup(): void {
            clearTimeout(timeout);
            if (!child.killed) {
                child.kill("SIGTERM");
            }
        }

        function fail(err: Error): void {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(err);
        }

        function succeed(data: JSONRecord): void {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(data);
        }

        function send(payload: unknown): void {
            child.stdin.write(JSON.stringify(payload) + "\n");
        }

        function handleLine(line: string): void {
            if (!line) {
                return;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                return;
            }
            if (!isRecord(parsed)) {
                return;
            }

            const id = toNumber(parsed.id);
            if (id == 1) {
                send({ method: "initialized", params: {} });
                send({ id: 2, method: "account/read", params: { includeApiKey: false } });
                send({ id: 3, method: "account/rateLimits/read", params: null });
                return;
            }

            if (id == 3) {
                const result = readNestedRecord(parsed, "result");
                if (!result) {
                    fail(new Error("RPC missing result field"));
                    return;
                }
                succeed(result);
            }
        }

        child.stdout.on("data", (chunk: Buffer) => {
            stdoutBuffer += chunk.toString("utf8");
            while (true) {
                const newlineIndex = stdoutBuffer.indexOf("\n");
                if (newlineIndex < 0) {
                    break;
                }
                const line = stdoutBuffer.slice(0, newlineIndex).trim();
                stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
                handleLine(line);
            }
        });

        child.stderr.on("data", (chunk: Buffer) => {
            stderrBuffer += chunk.toString("utf8");
        });

        child.on("error", (err: Error) => {
            fail(err);
        });

        child.on("exit", (code: number | null) => {
            if (settled) {
                return;
            }
            const msg = stderrBuffer.trim() || `RPC exited (${code ?? -1})`;
            fail(new Error(msg));
        });

        send({ id: 1, method: "initialize", params: { clientInfo: { name: "claudexbar", version: "0.2.0" } } });
    });

    const rateLimitsById = readNestedRecord(rateLimitResult, "rateLimitsByLimitId");
    const codexLimit = rateLimitsById ? readNestedRecord(rateLimitsById, "codex") : null;
    const rateLimits = codexLimit ?? readNestedRecord(rateLimitResult, "rateLimits");

    if (!rateLimits) {
        throw new Error("RPC response missing rate limits");
    }

    const primary = readNestedRecord(rateLimits, "primary");
    const secondary = readNestedRecord(rateLimits, "secondary");
    const creditsNode = readNestedRecord(rateLimits, "credits");

    const sessionPct = toNumber(primary?.usedPercent);
    const weeklyPct = toNumber(secondary?.usedPercent);

    if (sessionPct == null || weeklyPct == null) {
        throw new Error("RPC missing usage windows");
    }

    return {
        sessionPct: clamp(Math.round(sessionPct), 0, 100),
        weeklyPct: clamp(Math.round(weeklyPct), 0, 100),
        sessionResetAt: toNumber(primary?.resetsAt),
        weeklyResetAt: toNumber(secondary?.resetsAt),
        sessionWindowMinutes: toNumber(primary?.windowDurationMins),
        weeklyWindowMinutes: toNumber(secondary?.windowDurationMins),
        credits: toNumber(creditsNode?.balance),
        source: "rpc",
        planType: toStringValue(rateLimits.planType),
    };
}

function codexUsageToPayload(usage: CodexUsageSnapshot): WaybarPayload {
    const sessionCountdown = formatCountdown(usage.sessionResetAt);
    const weeklyCountdown = formatCountdown(usage.weeklyResetAt);
    const sessionWindowMs = usage.sessionWindowMinutes != null ? usage.sessionWindowMinutes * 60_000 : null;
    const weeklyWindowMs = usage.weeklyWindowMinutes != null ? usage.weeklyWindowMinutes * 60_000 : null;

    const sessionPacing = calcPacing(usage.sessionPct, usage.sessionResetAt, sessionWindowMs);
    const weeklyPacing = calcPacing(usage.weeklyPct, usage.weeklyResetAt, weeklyWindowMs);

    const cssClass = deriveCssClass(usage.weeklyPct, weeklyPacing);

    const tooltipLines = [
        "ClaudexBar",
        "-----------",
        `Provider: Codex (${usage.source})`,
        "",
        `Session: ${usage.sessionPct}% (${sessionPacing.status})`,
        `  Resets in ${sessionCountdown}`,
        "",
        `Weekly: ${usage.weeklyPct}% (${weeklyPacing.status})`,
        `  Resets in ${weeklyCountdown}`,
    ];

    return {
        text: addProviderBadge(
            `${weeklyPacing.icon} ◉${usage.weeklyPct}% ⧖${weeklyPacing.timeElapsedPct}% ${weeklyCountdown}`,
            "O"),
        tooltip: tooltipLines.join("\n"),
        class: mergeClasses(cssClass, "provider-codex"),
        percentage: usage.sessionPct,
    };
}

type ClaudeOAuth = {
    raw: JSONRecord;
    oauth: JSONRecord;
    accessToken: string;
    refreshToken: string | null;
    expiresAtMs: number | null;
};

async function loadClaudeOAuth(): Promise<ClaudeOAuth> {
    let rawText: string;
    try {
        rawText = await readFile(CLAUDE_CREDS_PATH, "utf8");
    } catch {
        throw new Error("Missing ~/.claude/.credentials.json. Run: claude");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        throw new Error("Invalid ~/.claude/.credentials.json JSON");
    }

    if (!isRecord(parsed)) {
        throw new Error("Unexpected ~/.claude/.credentials.json shape");
    }

    const oauth = readNestedRecord(parsed, "claudeAiOauth");
    if (!oauth) {
        throw new Error("Missing claudeAiOauth in credentials. Run: claude");
    }

    const accessToken = toStringValue(oauth.accessToken);
    const refreshToken = toStringValue(oauth.refreshToken);
    const expiresAtMs = toNumber(oauth.expiresAt);

    if (!accessToken) {
        throw new Error("Missing Claude access token. Run: claude");
    }

    return {
        raw: parsed,
        oauth,
        accessToken,
        refreshToken,
        expiresAtMs,
    };
}

async function saveClaudeOAuth(raw: JSONRecord): Promise<void> {
    await writeFile(CLAUDE_CREDS_PATH, JSON.stringify(raw, null, 2), "utf8");
}

async function maybeRefreshClaudeToken(auth: ClaudeOAuth): Promise<ClaudeOAuth> {
    if (!auth.refreshToken) {
        return auth;
    }

    const shouldRefresh = auth.expiresAtMs != null && auth.expiresAtMs < Date.now() + CLAUDE_REFRESH_BUFFER_MS;
    if (!shouldRefresh) {
        return auth;
    }

    const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLAUDE_CLIENT_ID,
        refresh_token: auth.refreshToken,
    });

    const response = await fetch(CLAUDE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });

    if (!response.ok) {
        throw new Error(`Claude token refresh failed: ${response.status}`);
    }

    const payload = await response.json();
    if (!isRecord(payload)) {
        throw new Error("Invalid Claude token refresh payload");
    }

    const accessToken = toStringValue(payload.access_token);
    const refreshToken = toStringValue(payload.refresh_token) ?? auth.refreshToken;
    const expiresIn = toNumber(payload.expires_in);

    if (!accessToken || expiresIn == null) {
        throw new Error("Incomplete Claude refresh response");
    }

    auth.oauth.accessToken = accessToken;
    auth.oauth.refreshToken = refreshToken;
    auth.oauth.expiresAt = Date.now() + expiresIn * 1000;
    await saveClaudeOAuth(auth.raw);

    return {
        ...auth,
        accessToken,
        refreshToken,
        expiresAtMs: toNumber(auth.oauth.expiresAt),
    };
}

function parseEpochSecondsFromIso(value: string | null): number | null {
    if (!value) {
        return null;
    }
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
        return null;
    }
    return Math.round(ms / 1000);
}

async function fetchClaudePayload(): Promise<WaybarPayload> {
    const loaded = await loadClaudeOAuth();
    const auth = await maybeRefreshClaudeToken(loaded);

    const response = await fetch(CLAUDE_USAGE_URL, {
        headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
        },
    });

    if (!response.ok) {
        throw new Error(`Claude usage API ${response.status}`);
    }

    const body = await response.json();
    if (!isRecord(body)) {
        throw new Error("Invalid Claude usage payload");
    }

    const sessionWindow = readNestedRecord(body, "five_hour");
    const weeklyWindow = readNestedRecord(body, "seven_day");
    if (!sessionWindow || !weeklyWindow) {
        throw new Error("Claude usage windows missing");
    }

    const sessionPctRaw = toNumber(sessionWindow.utilization);
    const weeklyPctRaw = toNumber(weeklyWindow.utilization);
    const sessionResetIso = toStringValue(sessionWindow.resets_at);
    const weeklyResetIso = toStringValue(weeklyWindow.resets_at);

    if (sessionPctRaw == null || weeklyPctRaw == null) {
        throw new Error("Claude usage percentages missing");
    }

    const sessionPct = clamp(Math.round(sessionPctRaw), 0, 100);
    const weeklyPct = clamp(Math.round(weeklyPctRaw), 0, 100);
    const sessionResetAt = parseEpochSecondsFromIso(sessionResetIso);
    const weeklyResetAt = parseEpochSecondsFromIso(weeklyResetIso);

    const sessionPacing = calcPacing(sessionPct, sessionResetAt, 5 * 60 * 60 * 1000);
    const weeklyPacing = calcPacing(weeklyPct, weeklyResetAt, 7 * 24 * 60 * 60 * 1000);

    const cssClass = deriveCssClass(weeklyPct, weeklyPacing);
    const sessionCountdown = formatCountdown(sessionResetAt);
    const weeklyCountdown = formatCountdown(weeklyResetAt);

    return {
        text: addProviderBadge(
            `${weeklyPacing.icon} ◉${weeklyPct}% ⧖${weeklyPacing.timeElapsedPct}% ${weeklyCountdown}`,
            "A"),
        tooltip: [
            "ClaudexBar",
            "-----------",
            "Provider: Claude (oauth)",
            "",
            `Session: ${sessionPct}% (${sessionPacing.status})`,
            `  Resets in ${sessionCountdown}`,
            "",
            `Weekly: ${weeklyPct}% (${weeklyPacing.status})`,
            `  Resets in ${weeklyCountdown}`,
        ].join("\n"),
        class: mergeClasses(cssClass, "provider-claude"),
        percentage: sessionPct,
    };
}

function errorPayload(message: string): WaybarPayload {
    return {
        text: "⚠ cdx",
        tooltip: `ClaudexBar\n-----------\n${message}`,
        class: "error",
    };
}

async function renderClaudex(provider: Provider): Promise<WaybarPayload> {
    if (provider == CLAUDE_PROVIDER) {
        try {
            return await fetchClaudePayload();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return errorPayload(`Claude failed: ${message}`);
        }
    }

    try {
        const usage = await fetchCodexUsageViaOAuth();
        return codexUsageToPayload(usage);
    } catch (oauthErr) {
        try {
            const usage = await fetchCodexUsageViaRpc();
            return codexUsageToPayload(usage);
        } catch (rpcErr) {
            const oauthMessage = oauthErr instanceof Error ? oauthErr.message : String(oauthErr);
            const rpcMessage = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);
            return errorPayload(`Codex failed\nOAuth: ${oauthMessage}\nRPC: ${rpcMessage}`);
        }
    }
}

async function main(): Promise<void> {
    const args = parseArgs(Bun.argv.slice(2));

    if (args.toggleProvider) {
        const current = await readProvider();
        const next = nextProvider(current);
        await writeProvider(next);
        if (!args.provider) {
            await refreshWaybar();
            console.log(next);
            return;
        }
    }

    if (args.provider) {
        await writeProvider(args.provider);
        if (!args.toggleProvider) {
            await refreshWaybar();
            console.log(args.provider);
            return;
        }
    }

    const provider = await readProvider();
    const payload = await renderClaudex(provider);
    console.log(JSON.stringify(payload));
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(errorPayload(message)));
});
