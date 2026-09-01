#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

const HOME = homedir();
const STATE_DIR = `${HOME}/.codex/claudexbar`;
const PROVIDER_STATE_PATH = `${STATE_DIR}/provider`;

const CLAUDE_PROVIDER = "claude";
const CODEX_PROVIDER = "codex";
const GROK_PROVIDER = "grok";

const CODEX_AUTH_PATH = `${HOME}/.codex/auth.json`;
const CODEX_CONFIG_PATH = `${HOME}/.codex/config.toml`;

const GROK_AUTH_PATH = `${STATE_DIR}/grok-auth.json`;
const GROK_LOGIN_URL = "https://cursor.com/loginDeepControl";
const GROK_AUTH_POLL_URL = "https://api2.cursor.sh/auth/poll";
const GROK_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus";
const CURSOR_MONTHLY_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const GROK_AUTH_ERROR = "Grok sign-in required. Sign in or reconnect Grok.";
const GROK_WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const GROK_LOGIN_TIMEOUT_MS = 2 * 60 * 1000;

const CLAUDE_CREDS_PATH = `${HOME}/.claude/.credentials.json`;
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const CLAUDE_SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
export const CLAUDE_WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CLAUDE_CACHE_PATH = `${STATE_DIR}/claude-last-good.json`;
const CLAUDE_BACKOFF_PATH = `${STATE_DIR}/claude-backoff.json`;
const CLAUDE_MIN_BACKOFF_MS = 15 * 60 * 1000;

// Quattro's omarchy-shell bar never re-runs a command widget's exec after an
// onClick, only on its interval timer. The widget therefore runs on a short
// interval (see shell.json) and this render cache keeps API calls at the old
// ~5-minute cadence: each exec prints the cached payload for the current
// provider unless it has gone stale.
const RENDER_CACHE_TTL_MS = 5 * 60 * 1000;
const RENDER_CACHE_ERROR_TTL_MS = 30 * 1000;

function renderCachePath(provider: Provider): string {
    return `${STATE_DIR}/render-${provider}.json`;
}

export type Provider = typeof CLAUDE_PROVIDER | typeof CODEX_PROVIDER | typeof GROK_PROVIDER;

type Args = {
    provider: Provider | null;
    toggleProvider: boolean;
    loginGrok: boolean;
    allProviders: boolean;
};

type UsageRowPacing = {
    expectedPercentage: number;
};

type UsageRow = {
    label: string;
    percentage: number;
    resetText: string;
    severity: "normal" | "warning" | "critical";
    pacing?: UsageRowPacing;
};

type WaybarPayload = {
    text: string;
    tooltip: string;
    class?: string | string[];
    percentage?: number;
    percentageLabel?: string;
    resetCredits?: number;
    updatedAt?: string;
    authenticationRequired?: boolean;
    usageRows?: UsageRow[];
};

export type AllProvidersPayload = {
    providers: Array<{
        provider: Provider;
        weeklyPace: number | null;
        payload: WaybarPayload;
    }>;
};

type SpawnResult = {
    stdout: string;
    stderr: string;
    code: number;
};

type ClaudeCachedPayload = {
    savedAtMs: number;
    payload: WaybarPayload;
};

type ClaudeBackoffState = {
    retryAtMs: number;
    reason: string;
};

type Pacing = {
    icon: string;
    status: string;
    devPct: number;
    timeElapsedPct: number;
};

export type CodexUsageSnapshot = {
    sessionPct: number | null;
    weeklyPct: number | null;
    sessionResetAt: number | null;
    weeklyResetAt: number | null;
    sessionWindowMinutes: number | null;
    weeklyWindowMinutes: number | null;
    credits: number | null;
    resetCredits: number | null;
    source: "oauth" | "rpc";
    planType: string | null;
};

export type GrokUsageSnapshot = {
    weeklyPct: number;
    weeklyResetAt: number;
    weeklyWindowMs: number;
};

export type CursorMonthlyUsageSnapshot = {
    cursorModelsPct: number;
    otherModelsPct: number;
    monthlyStartAt: number;
    monthlyResetAt: number;
};


type GrokCredentials = {
    accessToken: string;
    refreshToken: string;
};

type GrokUsageDependencies = {
    authPath?: string;
    usageUrl?: string;
    monthlyUsageUrl?: string;
    fetchImpl?: typeof fetch;
};

type GrokLoginDependencies = {
    authPath?: string;
    pollUrl?: string;
    fetchImpl?: typeof fetch;
    openBrowser?: (url: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    nowMs?: () => number;
    uuid?: () => string;
    verifier?: () => string;
};

class GrokAuthenticationError extends Error {}

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

export function decodeMacOSKeychainSecret(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length > 0 && trimmed.length % 2 == 0 && /^[0-9a-f]+$/i.test(trimmed)) {
        return Buffer.from(trimmed, "hex").toString("utf8");
    }
    return trimmed;
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
    let loginGrok = false;
    let allProviders = false;

    for (let idx = 0; idx < argv.length; idx += 1) {
        const arg = argv[idx];
        if (arg == "--all") {
            allProviders = true;
            continue;
        }
        if (arg == "--toggle") {
            toggleProvider = true;
            continue;
        }
        if (arg == "--login" && argv[idx + 1] == GROK_PROVIDER) {
            loginGrok = true;
            idx += 1;
            continue;
        }
        if (arg == "--provider") {
            const next = argv[idx + 1];
            if (next == CLAUDE_PROVIDER || next == CODEX_PROVIDER || next == GROK_PROVIDER) {
                provider = next;
                idx += 1;
            }
            continue;
        }
    }

    return {
        provider,
        toggleProvider,
        loginGrok,
        allProviders,
    };
}

async function ensureStateDir(): Promise<void> {
    await mkdir(STATE_DIR, { recursive: true });
}

async function readProvider(): Promise<Provider> {
    try {
        const value = (await readFile(PROVIDER_STATE_PATH, "utf8")).trim();
        if (value == CLAUDE_PROVIDER || value == CODEX_PROVIDER || value == GROK_PROVIDER) {
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

async function readJsonFile(path: string): Promise<unknown | null> {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch {
        return null;
    }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
    await ensureStateDir();
    await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

function normalizeWaybarPayload(value: unknown): WaybarPayload | null {
    if (!isRecord(value)) {
        return null;
    }

    const text = toStringValue(value.text);
    const tooltip = toStringValue(value.tooltip);
    if (!text || !tooltip) {
        return null;
    }

    let cssClass: string | string[] | undefined;
    if (typeof value.class == "string") {
        cssClass = value.class;
    } else if (Array.isArray(value.class) && value.class.every((entry) => typeof entry == "string")) {
        cssClass = value.class;
    }

    const percentage = toNumber(value.percentage) ?? undefined;
    const percentageLabel = toStringValue(value.percentageLabel) ?? undefined;
    const resetCredits = toNumber(value.resetCredits) ?? undefined;
    const updatedAt = toStringValue(value.updatedAt) ?? undefined;
    const usageRows = Array.isArray(value.usageRows)
        && value.usageRows.every((row) => isRecord(row)
            && typeof row.label == "string" && row.label.length > 0
            && typeof row.percentage == "number" && Number.isFinite(row.percentage)
            && row.percentage >= 0 && row.percentage <= 100
            && typeof row.resetText == "string" && row.resetText.length > 0
            && (row.severity == "normal" || row.severity == "warning" || row.severity == "critical")
            && (row.pacing == null || (isRecord(row.pacing)
                && typeof row.pacing.expectedPercentage == "number"
                && Number.isFinite(row.pacing.expectedPercentage)
                && row.pacing.expectedPercentage >= 0 && row.pacing.expectedPercentage <= 100)))
        ? value.usageRows as UsageRow[]
        : undefined;
    const authenticationRequired = typeof value.authenticationRequired == "boolean"
        ? value.authenticationRequired
        : undefined;
    return {
        text,
        tooltip,
        class: cssClass,
        percentage,
        percentageLabel,
        resetCredits,
        usageRows,
        updatedAt,
        authenticationRequired,
    };
}

function isErrorPayload(payload: WaybarPayload): boolean {
    const klass = payload.class;
    return klass == "error" || (Array.isArray(klass) && klass.includes("error"));
}

export function stripLegacyBarCountdown(text: string): string {
    return text.replace(/\s+(?:\d+d\d+h|\d+h\d+m)$/, "");
}

export function compactLegacyTooltip(tooltip: string): string {
    return tooltip
        .replace(/^ClaudexBar\n-+\n\n?/, "")
        .replace(/^(Session|Weekly):\s*(\d+(?:\.\d+)?%)\s*(?:\([^)]*\))?\n\s*Resets in\s*(.+)$/gm,
            (_, label: string, percentage: string, reset: string) =>
                `${label == "Weekly" ? "Week" : label} ${percentage} · reset ${reset}`)
        .replace(/^(Session|Weekly) (\d+(?:\.\d+)?%) · (?:on track|\d+% (?:under|ahead)|unknown pace) · reset (.+)$/gm,
            (_, label: string, percentage: string, reset: string) =>
                `${label == "Weekly" ? "Week" : label} ${percentage} · reset ${reset}`)
        .replace(/^Weekly unavailable$/gm, "Week unavailable")
        .replace(/\n{2,}/g, "\n");
}

async function loadFreshRenderCache(provider: Provider): Promise<WaybarPayload | null> {
    const parsed = await readJsonFile(renderCachePath(provider));
    if (!isRecord(parsed)) {
        return null;
    }
    const savedAtMs = toNumber(parsed.savedAtMs);
    const payload = normalizeWaybarPayload(parsed.payload);
    if (savedAtMs == null || !payload) {
        return null;
    }
    const ttl = isErrorPayload(payload) ? RENDER_CACHE_ERROR_TTL_MS : RENDER_CACHE_TTL_MS;
    if (Date.now() - savedAtMs > ttl) {
        return null;
    }
    return {
        ...payload,
        text: stripLegacyBarCountdown(payload.text),
        tooltip: compactLegacyTooltip(payload.tooltip),
    };
}

async function saveRenderCache(provider: Provider, payload: WaybarPayload): Promise<void> {
    await writeJsonFile(renderCachePath(provider), {
        savedAtMs: Date.now(),
        payload,
    });
}

async function loadClaudeCachedPayload(): Promise<ClaudeCachedPayload | null> {
    const parsed = await readJsonFile(CLAUDE_CACHE_PATH);
    if (!isRecord(parsed)) {
        return null;
    }

    const savedAtMs = toNumber(parsed.savedAtMs);
    const payload = normalizeWaybarPayload(parsed.payload);
    if (savedAtMs == null || !payload) {
        return null;
    }

    return { savedAtMs, payload };
}

async function saveClaudeCachedPayload(payload: WaybarPayload): Promise<void> {
    await writeJsonFile(CLAUDE_CACHE_PATH, {
        savedAtMs: Date.now(),
        payload,
    });
}

async function loadClaudeBackoff(): Promise<ClaudeBackoffState | null> {
    const parsed = await readJsonFile(CLAUDE_BACKOFF_PATH);
    if (!isRecord(parsed)) {
        return null;
    }

    const retryAtMs = toNumber(parsed.retryAtMs);
    const reason = toStringValue(parsed.reason) ?? "Rate limited. Please try again later.";
    if (retryAtMs == null || retryAtMs <= Date.now()) {
        return null;
    }

    return { retryAtMs, reason };
}

async function saveClaudeBackoff(state: ClaudeBackoffState): Promise<void> {
    await writeJsonFile(CLAUDE_BACKOFF_PATH, state);
}

async function clearClaudeBackoff(): Promise<void> {
    await saveClaudeBackoff({
        retryAtMs: 0,
        reason: "",
    });
}

export function nextProvider(provider: Provider): Provider {
    if (provider == CODEX_PROVIDER) {
        return CLAUDE_PROVIDER;
    }
    if (provider == CLAUDE_PROVIDER) {
        return GROK_PROVIDER;
    }
    return CODEX_PROVIDER;
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
    // Waybar re-runs the module on this signal. The omarchy-shell bar has no
    // equivalent; there the widget's short interval plus the primed render
    // cache handle display refresh instead, and this pkill matches nothing.
    if (process.platform != "linux") {
        return;
    }
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

function parseRetryAfterMs(value: string | null): number | null {
    if (!value) {
        return null;
    }

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }

    const retryAtMs = Date.parse(value);
    if (Number.isFinite(retryAtMs)) {
        return Math.max(0, retryAtMs - Date.now());
    }

    return null;
}

function formatLocalDateTime(ms: number): string {
    return new Date(ms).toLocaleString();
}

export function stampPayload(payload: WaybarPayload, updatedAtMs: number = Date.now()): WaybarPayload {
    const updatedAt = new Date(updatedAtMs);
    const updatedTime = updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return {
        ...payload,
        tooltip: `${payload.tooltip}\nUpdated: ${updatedTime}`,
        updatedAt: updatedAt.toISOString(),
    };
}

function annotateCachedClaudePayload(payload: WaybarPayload, detail: string): WaybarPayload {
    return {
        ...payload,
        text: stripLegacyBarCountdown(payload.text),
        tooltip: `${compactLegacyTooltip(payload.tooltip)}\nStale · cached Anthropic usage\n${detail}`,
        class: mergeClasses(payload.class, "stale", "provider-claude"),
    };
}

async function fallbackToCachedClaudePayload(detail: string): Promise<WaybarPayload | null> {
    const cached = await loadClaudeCachedPayload();
    if (!cached) {
        return null;
    }

    const payload = cached.payload.updatedAt ? cached.payload : stampPayload(cached.payload, cached.savedAtMs);
    return annotateCachedClaudePayload(payload, detail);
}

function addProviderBadge(text: string, badge: string): string {
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

export function formatCredits(value: number): string {
    const rounded = Math.round(value * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "");
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

export function calcPacing(usagePct: number, resetAtEpochSeconds: number | null, windowMs: number | null): Pacing {
    if (resetAtEpochSeconds == null || windowMs == null || windowMs <= 0) {
        return { icon: "→", status: "unknown pace", devPct: 0, timeElapsedPct: 0 };
    }

    const resetAtMs = resetAtEpochSeconds * 1000;
    const startAtMs = resetAtMs - windowMs;
    const elapsedPct = clamp(Math.round(((Date.now() - startAtMs) / windowMs) * 100), 0, 100);
    const pacing = elapsedPct > 0 ? usagePct / elapsedPct : 0;
    const devPct = Math.round((pacing - 1) * 100);

    if (devPct >= 10) {
        return { icon: "↑", status: `${devPct}% ahead`, devPct, timeElapsedPct: elapsedPct };
    }
    if (devPct > 0) {
        return { icon: "↗", status: `${devPct}% ahead`, devPct, timeElapsedPct: elapsedPct };
    }
    if (devPct <= -10) {
        return { icon: "↓", status: `${-devPct}% under`, devPct, timeElapsedPct: elapsedPct };
    }
    if (devPct < 0) {
        return { icon: "↘", status: `${-devPct}% under`, devPct, timeElapsedPct: elapsedPct };
    }

    return { icon: "→", status: "on track", devPct, timeElapsedPct: elapsedPct };
}

function deriveCssClass(usagePct: number, quotaPacing: Pacing): string {
    const expectedPct = quotaPacing.timeElapsedPct;
    if (usagePct <= expectedPct) {
        return "";
    }
    if (expectedPct <= 0 || usagePct / expectedPct >= 1.10) {
        return "critical";
    }
    return "warning";
}


function formatQuotaRow(
    label: "Session" | "Week",
    percentage: number,
    reset: string,
    severity: string = "",
): string {
    const warning = severity == "warning" || severity == "critical" ? ` · ${severity}` : "";
    return `${label} ${percentage}%${warning} · reset ${reset}`;
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

export function parseCodexOAuthUsage(raw: unknown): CodexUsageSnapshot {
    if (!isRecord(raw)) {
        throw new Error("Codex OAuth response is not an object");
    }

    const rateLimit = readNestedRecord(raw, "rate_limit");
    const primary = rateLimit ? readNestedRecord(rateLimit, "primary_window") : null;
    const secondary = rateLimit ? readNestedRecord(rateLimit, "secondary_window") : null;
    const primaryWindowSeconds = toNumber(primary?.limit_window_seconds);
    const primaryIsWeekly = secondary == null && primaryWindowSeconds != null && primaryWindowSeconds >= 24 * 60 * 60;
    const session = primaryIsWeekly ? null : primary;
    const weekly = secondary ?? (primaryIsWeekly ? primary : null);

    const sessionPct = toNumber(session?.used_percent) ?? null;
    const weeklyPct = toNumber(weekly?.used_percent) ?? null;
    const sessionResetAt = toNumber(session?.reset_at);
    const weeklyResetAt = toNumber(weekly?.reset_at);
    const sessionWindowSeconds = toNumber(session?.limit_window_seconds);
    const weeklyWindowSeconds = toNumber(weekly?.limit_window_seconds);

    if (sessionPct == null && weeklyPct == null) {
        throw new Error("OAuth payload missing rate-limit windows");
    }

    const creditsNode = readNestedRecord(raw, "credits");
    const credits = toNumber(creditsNode?.balance);
    const resetCreditsNode = readNestedRecord(raw, "rate_limit_reset_credits");
    const resetCredits = toNumber(resetCreditsNode?.available_count);
    const planType = toStringValue(raw.plan_type);

    return {
        sessionPct: sessionPct == null ? null : clamp(Math.round(sessionPct), 0, 100),
        weeklyPct: weeklyPct == null ? null : clamp(Math.round(weeklyPct), 0, 100),
        sessionResetAt: sessionResetAt == null ? null : Math.round(sessionResetAt),
        weeklyResetAt: weeklyResetAt == null ? null : Math.round(weeklyResetAt),
        sessionWindowMinutes: sessionWindowSeconds == null ? null : Math.max(1, Math.round(sessionWindowSeconds / 60)),
        weeklyWindowMinutes: weeklyWindowSeconds == null ? null : Math.max(1, Math.round(weeklyWindowSeconds / 60)),
        credits,
        resetCredits,
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
    const primaryWindowMinutes = toNumber(primary?.windowDurationMins);
    const primaryIsWeekly = secondary == null && primaryWindowMinutes != null && primaryWindowMinutes >= 24 * 60;
    const session = primaryIsWeekly ? null : primary;
    const weekly = secondary ?? (primaryIsWeekly ? primary : null);
    const creditsNode = readNestedRecord(rateLimits, "credits");
    const resetCreditsNode = readNestedRecord(rateLimitResult, "rateLimitResetCredits");

    const sessionPct = toNumber(session?.usedPercent);
    const weeklyPct = toNumber(weekly?.usedPercent);

    if (sessionPct == null && weeklyPct == null) {
        throw new Error("RPC missing usage windows");
    }

    return {
        sessionPct: sessionPct == null ? null : clamp(Math.round(sessionPct), 0, 100),
        weeklyPct: weeklyPct == null ? null : clamp(Math.round(weeklyPct), 0, 100),
        sessionResetAt: toNumber(session?.resetsAt),
        weeklyResetAt: toNumber(weekly?.resetsAt),
        sessionWindowMinutes: toNumber(session?.windowDurationMins),
        weeklyWindowMinutes: toNumber(weekly?.windowDurationMins),
        credits: toNumber(creditsNode?.balance),
        resetCredits: toNumber(resetCreditsNode?.availableCount),
        source: "rpc",
        planType: toStringValue(rateLimits.planType),
    };
}

export function codexUsageToPayload(usage: CodexUsageSnapshot): WaybarPayload {
    const sessionCountdown = formatCountdown(usage.sessionResetAt);
    const weeklyCountdown = formatCountdown(usage.weeklyResetAt);
    const sessionWindowMs = usage.sessionWindowMinutes != null ? usage.sessionWindowMinutes * 60_000 : null;
    const weeklyWindowMs = usage.weeklyWindowMinutes != null ? usage.weeklyWindowMinutes * 60_000 : null;

    const sessionPacing = usage.sessionPct == null
        ? null
        : calcPacing(usage.sessionPct, usage.sessionResetAt, sessionWindowMs);
    const weeklyPacing = usage.weeklyPct == null
        ? null
        : calcPacing(usage.weeklyPct, usage.weeklyResetAt, weeklyWindowMs);
    const displayedPct = usage.weeklyPct ?? usage.sessionPct;
    const displayedPacing = weeklyPacing ?? sessionPacing;

    if (displayedPct == null || displayedPacing == null) {
        throw new Error("Codex usage missing rate-limit windows");
    }

    const cssClass = deriveCssClass(displayedPct, displayedPacing);
    const creditLabel = usage.resetCredits == null ? null : formatCredits(usage.resetCredits);
    const providerBadge = creditLabel == null ? "O" : `O(${creditLabel})`;

    const tooltipLines: string[] = [];
    const sessionSeverity = usage.sessionPct == null || sessionPacing == null
        ? ""
        : deriveCssClass(usage.sessionPct, sessionPacing);
    const weeklySeverity = usage.weeklyPct == null || weeklyPacing == null
        ? ""
        : deriveCssClass(usage.weeklyPct, weeklyPacing);
    const usageRows: UsageRow[] = [];
    if (usage.sessionPct != null) {
        usageRows.push({
            label: "Session",
            percentage: usage.sessionPct,
            resetText: sessionCountdown,
            severity: sessionSeverity == "warning" || sessionSeverity == "critical" ? sessionSeverity : "normal",
            pacing: sessionPacing == null
                ? undefined
                : { expectedPercentage: sessionPacing.timeElapsedPct },
        });
    }
    if (usage.weeklyPct != null) {
        usageRows.push({
            label: "Weekly",
            percentage: usage.weeklyPct,
            resetText: weeklyCountdown,
            severity: weeklySeverity == "warning" || weeklySeverity == "critical" ? weeklySeverity : "normal",
            pacing: weeklyPacing == null
                ? undefined
                : { expectedPercentage: weeklyPacing.timeElapsedPct },
        });
    }

    if (usage.sessionPct != null && sessionPacing != null) {
        tooltipLines.push(formatQuotaRow("Session", usage.sessionPct, sessionCountdown, sessionSeverity));
    } else {
        tooltipLines.push("Session unavailable");
    }

    if (usage.weeklyPct != null && weeklyPacing != null) {
        tooltipLines.push(formatQuotaRow("Week", usage.weeklyPct, weeklyCountdown, weeklySeverity));
    } else {
        tooltipLines.push("Week unavailable");
    }

    if (creditLabel != null) {
        tooltipLines.push(`Credits ${creditLabel}`);
    }

    return stampPayload({
        text: addProviderBadge(
            `${displayedPacing.icon} ◉${displayedPct}% ⧖${displayedPacing.timeElapsedPct}%`,
            providerBadge),
        tooltip: tooltipLines.join("\n"),
        class: mergeClasses(cssClass, "provider-codex"),
        percentage: usage.sessionPct ?? usage.weeklyPct ?? undefined,
        percentageLabel: usage.sessionPct == null ? "Weekly" : "Session",
        resetCredits: usage.resetCredits ?? undefined,
        usageRows,
    });
}

async function loadGrokCredentials(authPath: string): Promise<GrokCredentials> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(authPath, "utf8"));
    } catch {
        throw new GrokAuthenticationError(GROK_AUTH_ERROR);
    }
    if (!isRecord(parsed)) {
        throw new GrokAuthenticationError(GROK_AUTH_ERROR);
    }
    const accessToken = toStringValue(parsed.accessToken);
    const refreshToken = toStringValue(parsed.refreshToken);
    if (!accessToken || !refreshToken) {
        throw new GrokAuthenticationError(GROK_AUTH_ERROR);
    }
    return { accessToken, refreshToken };
}

async function saveGrokCredentials(authPath: string, credentials: GrokCredentials): Promise<void> {
    await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${authPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(credentials), { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, authPath);
    await chmod(authPath, 0o600);
}

async function openLoginBrowser(url: string): Promise<void> {
    const command = process.platform == "darwin" ? "open" : "xdg-open";
    const result = await runCommand(command, [url], 10_000);
    if (result.code != 0) {
        throw new Error("Could not open Grok sign-in.");
    }
}

export async function loginGrok(dependencies: GrokLoginDependencies = {}): Promise<void> {
    const verifier = dependencies.verifier?.() ?? randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const uuid = dependencies.uuid?.() ?? randomUUID();
    const loginUrl = new URL(GROK_LOGIN_URL);
    loginUrl.searchParams.set("challenge", challenge);
    loginUrl.searchParams.set("uuid", uuid);
    loginUrl.searchParams.set("mode", "login");
    loginUrl.searchParams.set("redirectTarget", "sand");
    loginUrl.searchParams.set("supportsSelectedTeamLogin", "true");

    await (dependencies.openBrowser ?? openLoginBrowser)(loginUrl.toString());

    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const sleep = dependencies.sleep ?? ((ms: number) => Bun.sleep(ms));
    const nowMs = dependencies.nowMs ?? Date.now;
    const deadline = nowMs() + GROK_LOGIN_TIMEOUT_MS;
    const pollUrl = new URL(dependencies.pollUrl ?? GROK_AUTH_POLL_URL);
    pollUrl.searchParams.set("uuid", uuid);
    pollUrl.searchParams.set("verifier", verifier);

    while (nowMs() < deadline) {
        let response: Response | null = null;
        try {
            response = await fetchImpl(pollUrl, {
                method: "GET",
                headers: { Accept: "application/json" },
                signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - nowMs()))),
            });
        } catch {
            // Keep polling until the bounded deadline.
        }

        if (response?.ok) {
            let body: unknown = null;
            try {
                body = await response.json();
            } catch {
                // An incomplete poll response is not a completed login.
            }
            if (isRecord(body)) {
                const accessToken = toStringValue(body.accessToken);
                const refreshToken = toStringValue(body.refreshToken);
                if (accessToken && refreshToken) {
                    await saveGrokCredentials(dependencies.authPath ?? GROK_AUTH_PATH, {
                        accessToken,
                        refreshToken,
                    });
                    return;
                }
            }
        }
        await sleep(1_000);
    }
    throw new Error("Grok sign-in timed out. Try again.");
}

export function parseGrokUsage(raw: unknown): GrokUsageSnapshot {
    if (!isRecord(raw) || typeof raw.usagePercent != "number"
        || !Number.isFinite(raw.usagePercent)
        || raw.usagePercent < 0 || raw.usagePercent > 100
        || typeof raw.nextResetTimestampUtc != "string") {
        throw new Error("Invalid Grok usage response");
    }
    const resetAtMs = Date.parse(raw.nextResetTimestampUtc);
    if (!Number.isFinite(resetAtMs)) {
        throw new Error("Invalid Grok usage response");
    }
    return {
        weeklyPct: Math.round(raw.usagePercent),
        weeklyResetAt: Math.round(resetAtMs / 1000),
        weeklyWindowMs: GROK_WEEKLY_WINDOW_MS,
    };
}
export function parseCursorMonthlyUsage(raw: unknown): CursorMonthlyUsageSnapshot {
    if (!isRecord(raw) || !isRecord(raw.planUsage)) {
        throw new Error("Invalid Cursor monthly usage response");
    }
    const cursorModelsPct = raw.planUsage.autoPercentUsed;
    const otherModelsPct = raw.planUsage.apiPercentUsed;
    const billingCycleStart = raw.billingCycleStart;
    const billingCycleEnd = raw.billingCycleEnd;
    if (typeof cursorModelsPct != "number" || !Number.isFinite(cursorModelsPct)
        || cursorModelsPct < 0 || cursorModelsPct > 100
        || typeof otherModelsPct != "number" || !Number.isFinite(otherModelsPct)
        || otherModelsPct < 0 || otherModelsPct > 100
        || (typeof billingCycleStart != "number" && typeof billingCycleStart != "string")
        || (typeof billingCycleEnd != "number" && typeof billingCycleEnd != "string")) {
        throw new Error("Invalid Cursor monthly usage response");
    }
    const billingCycleStartMs = Number(billingCycleStart);
    const billingCycleEndMs = Number(billingCycleEnd);
    if (!Number.isSafeInteger(billingCycleStartMs) || billingCycleStartMs <= 0
        || !Number.isSafeInteger(billingCycleEndMs) || billingCycleEndMs <= billingCycleStartMs) {
        throw new Error("Invalid Cursor monthly usage response");
    }
    return {
        cursorModelsPct: Math.ceil(cursorModelsPct),
        otherModelsPct: Math.ceil(otherModelsPct),
        monthlyStartAt: Math.round(billingCycleStartMs / 1000),
        monthlyResetAt: Math.round(billingCycleEndMs / 1000),
    };
}

export function grokUsageToPayload(
    usage: GrokUsageSnapshot,
    monthlyUsage?: CursorMonthlyUsageSnapshot,
): WaybarPayload {
    const pacing = calcPacing(usage.weeklyPct, usage.weeklyResetAt, usage.weeklyWindowMs);
    const cssClass = deriveCssClass(usage.weeklyPct, pacing);
    const weeklySeverity = cssClass == "warning" || cssClass == "critical" ? cssClass : "normal";
    const usageRows: UsageRow[] = [];
    if (monthlyUsage != null) {
        const monthlyResetText = formatCountdown(monthlyUsage.monthlyResetAt);
        const monthlyWindowMs = (monthlyUsage.monthlyResetAt - monthlyUsage.monthlyStartAt) * 1000;
        const monthlyPacing = calcPacing(
            monthlyUsage.cursorModelsPct,
            monthlyUsage.monthlyResetAt,
            monthlyWindowMs,
        );
        const monthlyExpectedPercentage = monthlyPacing.timeElapsedPct;
        usageRows.push(
            {
                label: "Cursor Models (Monthly)",
                percentage: monthlyUsage.cursorModelsPct,
                resetText: monthlyResetText,
                severity: deriveCssClass(monthlyUsage.cursorModelsPct, monthlyPacing) || "normal",
                pacing: { expectedPercentage: monthlyExpectedPercentage },
            },
            {
                label: "Other Models (Monthly)",
                percentage: monthlyUsage.otherModelsPct,
                resetText: monthlyResetText,
                severity: deriveCssClass(monthlyUsage.otherModelsPct, monthlyPacing) || "normal",
                pacing: { expectedPercentage: monthlyExpectedPercentage },
            },
        );
    }
    usageRows.push({
        label: "GrokBot (Weekly)",
        percentage: usage.weeklyPct,
        resetText: formatCountdown(usage.weeklyResetAt),
        severity: weeklySeverity,
        pacing: { expectedPercentage: pacing.timeElapsedPct },
    });
    return stampPayload({
        text: addProviderBadge(
            `${pacing.icon} ◉${usage.weeklyPct}% ⧖${pacing.timeElapsedPct}%`,
            "X"),
        tooltip: formatQuotaRow("Week", usage.weeklyPct, formatCountdown(usage.weeklyResetAt), cssClass),
        class: mergeClasses(cssClass, "provider-grok"),
        percentage: usage.weeklyPct,
        percentageLabel: "Weekly",
        usageRows,
        authenticationRequired: false,
    });
}

export async function fetchGrokPayload(dependencies: GrokUsageDependencies = {}): Promise<WaybarPayload> {
    const credentials = await loadGrokCredentials(dependencies.authPath ?? GROK_AUTH_PATH);
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const requestInit: RequestInit = {
        method: "POST",
        headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
        },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
    };

    let response: Response;
    try {
        response = await fetchImpl(dependencies.usageUrl ?? GROK_USAGE_URL, requestInit);
    } catch {
        throw new Error("Grok usage request failed");
    }
    if (response.status == 401) {
        throw new GrokAuthenticationError(GROK_AUTH_ERROR);
    }
    if (!response.ok) {
        throw new Error(`Grok usage request failed (HTTP ${response.status})`);
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new Error("Invalid Grok usage response");
    }
    const weeklyUsage = parseGrokUsage(body);

    let monthlyUsage: CursorMonthlyUsageSnapshot | undefined;
    try {
        const monthlyResponse = await fetchImpl(
            dependencies.monthlyUsageUrl ?? CURSOR_MONTHLY_USAGE_URL,
            requestInit,
        );
        if (monthlyResponse.ok) {
            monthlyUsage = parseCursorMonthlyUsage(await monthlyResponse.json());
        }
    } catch {
        // Monthly Cursor usage is optional enrichment; weekly Grok remains authoritative.
    }
    return grokUsageToPayload(weeklyUsage, monthlyUsage);
}

export async function renderGrokPayload(
    dependencies: GrokUsageDependencies = {},
): Promise<WaybarPayload> {
    try {
        return await fetchGrokPayload(dependencies);
    } catch (err) {
        const message = err instanceof Error ? err.message : "Grok usage request failed";
        return stampPayload({
            text: "⚠ X",
            tooltip: message,
            class: ["error", "provider-grok"],
            authenticationRequired: err instanceof GrokAuthenticationError ? true : undefined,
        });
    }
}

type ClaudeOAuth = {
    raw: JSONRecord;
    oauth: JSONRecord;
    storage: "file" | "keychain";
    accessToken: string;
    refreshToken: string | null;
    expiresAtMs: number | null;
};

async function loadClaudeOAuth(): Promise<ClaudeOAuth> {
    let rawText: string;
    let storage: "file" | "keychain" = "file";
    try {
        rawText = await readFile(CLAUDE_CREDS_PATH, "utf8");
    } catch {
        if (process.platform != "darwin") {
            throw new Error("Missing ~/.claude/.credentials.json. Run: claude");
        }

        const result = await runCommand(
            "/usr/bin/security",
            ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
            5_000,
        );
        if (result.code != 0 || !result.stdout.trim()) {
            throw new Error("Missing Claude Code credentials in the macOS Keychain. Run: claude");
        }
        rawText = decodeMacOSKeychainSecret(result.stdout);
        storage = "keychain";
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
        storage,
        accessToken,
        refreshToken,
        expiresAtMs,
    };
}

async function saveClaudeOAuth(auth: ClaudeOAuth): Promise<void> {
    const serialized = JSON.stringify(auth.raw, null, 2);
    if (auth.storage == "file") {
        await writeFile(CLAUDE_CREDS_PATH, serialized, "utf8");
        return;
    }

    const account = process.env.USER?.trim() || HOME.split("/").filter(Boolean).at(-1) || "user";
    const result = await runCommand(
        "/usr/bin/security",
        ["add-generic-password", "-U", "-a", account, "-s", CLAUDE_KEYCHAIN_SERVICE, "-w", serialized],
        5_000,
    );
    if (result.code != 0) {
        throw new Error(`Could not update Claude credentials in Keychain: ${result.stderr.trim() || result.code}`);
    }
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
    await saveClaudeOAuth(auth);

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

async function readClaudeErrorMessage(response: Response): Promise<string | null> {
    try {
        const body = await response.json();
        if (!isRecord(body)) {
            return null;
        }

        const error = readNestedRecord(body, "error");
        return toStringValue(error?.message) ?? toStringValue(body.message);
    } catch {
        return null;
    }
}

async function fetchClaudePayload(): Promise<WaybarPayload> {
    const activeBackoff = await loadClaudeBackoff();
    if (activeBackoff) {
        const cached = await fallbackToCachedClaudePayload(
            `Live refresh after ${formatLocalDateTime(activeBackoff.retryAtMs)}\nReason: ${activeBackoff.reason}`,
        );
        if (cached) {
            return cached;
        }
    }

    const loaded = await loadClaudeOAuth();
    const auth = await maybeRefreshClaudeToken(loaded);

    const response = await fetch(CLAUDE_USAGE_URL, {
        headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
        },
    });

    if (response.status == 429) {
        const reason = await readClaudeErrorMessage(response) ?? "Rate limited. Please try again later.";
        const retryAfterMs = Math.max(parseRetryAfterMs(response.headers.get("retry-after")) ?? 0, CLAUDE_MIN_BACKOFF_MS);
        const backoff = {
            retryAtMs: Date.now() + retryAfterMs,
            reason,
        };
        await saveClaudeBackoff(backoff);

        const cached = await fallbackToCachedClaudePayload(
            `Live refresh after ${formatLocalDateTime(backoff.retryAtMs)}\nReason: ${reason}`,
        );
        if (cached) {
            return cached;
        }

        throw new Error(`Claude usage API 429: ${reason}`);
    }

    if (!response.ok) {
        const message = await readClaudeErrorMessage(response);
        throw new Error(message ? `Claude usage API ${response.status}: ${message}` : `Claude usage API ${response.status}`);
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

    const sessionPacing = calcPacing(sessionPct, sessionResetAt, CLAUDE_SESSION_WINDOW_MS);
    const weeklyPacing = calcPacing(weeklyPct, weeklyResetAt, CLAUDE_WEEKLY_WINDOW_MS);

    const cssClass = deriveCssClass(weeklyPct, weeklyPacing);
    const sessionSeverity = deriveCssClass(sessionPct, sessionPacing);
    const sessionCountdown = formatCountdown(sessionResetAt);
    const weeklyCountdown = formatCountdown(weeklyResetAt);

    const payload = stampPayload({
        text: addProviderBadge(
            `${weeklyPacing.icon} ◉${weeklyPct}% ⧖${weeklyPacing.timeElapsedPct}%`,
            "A"),
        tooltip: [
            formatQuotaRow("Session", sessionPct, sessionCountdown, sessionSeverity),
            formatQuotaRow("Week", weeklyPct, weeklyCountdown, cssClass),
        ].join("\n"),
        class: mergeClasses(cssClass, "provider-claude"),
        percentage: sessionPct,
        percentageLabel: "Session",
        usageRows: [
            {
                label: "Session",
                percentage: sessionPct,
                resetText: sessionCountdown,
                severity: sessionSeverity == "warning" || sessionSeverity == "critical" ? sessionSeverity : "normal",
                pacing: { expectedPercentage: sessionPacing.timeElapsedPct },
            },
            {
                label: "Weekly",
                percentage: weeklyPct,
                resetText: weeklyCountdown,
                severity: cssClass == "warning" || cssClass == "critical" ? cssClass : "normal",
                pacing: { expectedPercentage: weeklyPacing.timeElapsedPct },
            },
        ],
    });

    await saveClaudeCachedPayload(payload);
    await clearClaudeBackoff();
    return payload;
}

function errorPayload(message: string, authenticationRequired = false): WaybarPayload {
    return stampPayload({
        text: "⚠ cdx",
        tooltip: message,
        class: "error",
        authenticationRequired: authenticationRequired || undefined,
    });
}

export function providerAuthenticationRequired(provider: Provider, message: string): boolean {
    const lower = message.toLowerCase();
    if (lower.includes("unauthorized") || lower.includes("api 401") || lower.includes("http 401")) {
        return true;
    }
    if (provider == CLAUDE_PROVIDER) {
        return lower.includes("credentials")
            || lower.includes("claudeaioauth")
            || lower.includes("claude access token")
            || lower.includes("run: claude");
    }
    if (provider == CODEX_PROVIDER) {
        return lower.includes("auth.json")
            || lower.includes("no tokens")
            || lower.includes("codex access token")
            || lower.includes("run: codex login")
            || lower.includes("not logged in");
    }
    return false;
}

export function weeklyPacePercentagePoints(provider: Provider, payload: WaybarPayload): number | null {
    const weeklyLabel = provider == GROK_PROVIDER ? "GrokBot (Weekly)" : "Weekly";
    const weekly = payload.usageRows?.find((row) => row.label == weeklyLabel);
    if (!weekly?.pacing) {
        return null;
    }
    return Math.round(weekly.pacing.expectedPercentage - weekly.percentage);
}

async function renderClaudex(provider: Provider): Promise<WaybarPayload> {
    if (provider == CLAUDE_PROVIDER) {
        try {
            return await fetchClaudePayload();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const authenticationRequired = providerAuthenticationRequired(CLAUDE_PROVIDER, message);
            if (!authenticationRequired) {
                const cached = await fallbackToCachedClaudePayload(`Live fetch failed: ${message}`);
                if (cached) {
                    return cached;
                }
            }
            return errorPayload(`Claude failed: ${message}`, authenticationRequired);
        }
    }

    if (provider == GROK_PROVIDER) {
        return renderGrokPayload();
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
            const message = `Codex failed\nOAuth: ${oauthMessage}\nRPC: ${rpcMessage}`;
            return errorPayload(
                message,
                providerAuthenticationRequired(CODEX_PROVIDER, message),
            );
        }
    }
}

async function renderProviderPayload(provider: Provider): Promise<WaybarPayload> {
    const cached = await loadFreshRenderCache(provider);
    if (cached) {
        return cached;
    }
    const payload = await renderClaudex(provider);
    await saveRenderCache(provider, payload);
    return payload;
}

export async function renderAllProviders(
    render: (provider: Provider) => Promise<WaybarPayload> = renderProviderPayload,
): Promise<AllProvidersPayload> {
    const order: Provider[] = [CLAUDE_PROVIDER, CODEX_PROVIDER, GROK_PROVIDER];
    const providers = await Promise.all(order.map(async (provider) => {
        let payload: WaybarPayload;
        try {
            payload = await render(provider);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            payload = errorPayload(`${provider} failed: ${message}`);
        }
        return {
            provider,
            weeklyPace: weeklyPacePercentagePoints(provider, payload),
            payload,
        };
    }));
    return { providers };
}

// Render the newly selected provider right away so the bar's next poll picks
// up a fresh cache instead of showing the old provider while a live fetch runs.
async function primeRenderCache(provider: Provider): Promise<void> {
    try {
        const payload = await renderClaudex(provider);
        await saveRenderCache(provider, payload);
    } catch {
        // best effort; the periodic render will retry
    }
}

async function main(): Promise<void> {
    const args = parseArgs(Bun.argv.slice(2));

    if (args.loginGrok) {
        try {
            await loginGrok();
            await primeRenderCache(GROK_PROVIDER);
            console.log(GROK_PROVIDER);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Grok sign-in failed. Try again.";
            console.error(message);
            process.exitCode = 1;
        }
        return;
    }

    if (args.allProviders) {
        console.log(JSON.stringify(await renderAllProviders()));
        return;
    }

    if (args.toggleProvider) {
        const current = await readProvider();
        const next = nextProvider(current);
        await writeProvider(next);
        if (!args.provider) {
            console.log(next);
            await primeRenderCache(next);
            await refreshWaybar();
            return;
        }
    }

    if (args.provider) {
        await writeProvider(args.provider);
        if (!args.toggleProvider) {
            console.log(args.provider);
            await primeRenderCache(args.provider);
            await refreshWaybar();
            return;
        }
    }

    const provider = await readProvider();
    console.log(JSON.stringify(await renderProviderPayload(provider)));
}

if (import.meta.main) {
    main().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.log(JSON.stringify(errorPayload(message)));
    });
}
