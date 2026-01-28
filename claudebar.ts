#!/usr/bin/env bun
/**
 * ClaudeBar - Claude usage meter for Waybar
 * Uses official Claude OAuth API for exact usage data
 */

import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";

const CREDS_PATH = `${homedir()}/.claude/.credentials.json`;
const API_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Claude Max OAuth client ID
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

interface UsageWindow {
  utilization: number;
  resets_at: string;
}

interface ApiResponse {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  seven_day_sonnet?: UsageWindow;
}

function formatCountdown(resetAt: string): string {
  const ms = new Date(resetAt).getTime() - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 24 ? `${Math.floor(h / 24)}d${h % 24}h` : `${h}h${String(m).padStart(2, "0")}m`;
}

function calcPacing(usagePct: number, resetAt: string, windowMs: number): { icon: string; status: string; devPct: number; timeElapsedPct: number } {
  const msLeft = new Date(resetAt).getTime() - Date.now();
  const timeElapsedPct = Math.round(((windowMs - msLeft) / windowMs) * 100);
  const pacing = timeElapsedPct > 0 ? usagePct / timeElapsedPct : 0;
  if (pacing > 1.05) { const d = Math.round((pacing - 1) * 100); return { icon: "↑", status: `${d}% ahead`, devPct: d, timeElapsedPct }; }
  if (pacing < 0.95) { const d = Math.round((1 - pacing) * 100); return { icon: "↓", status: `${d}% under`, devPct: -d, timeElapsedPct }; }
  return { icon: "→", status: "on track", devPct: 0, timeElapsedPct };
}

async function refreshToken(creds: any): Promise<boolean> {
  const oauth = creds.claudeAiOauth;
  if (!oauth?.refreshToken) return false;

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: oauth.refreshToken,
      }),
    });

    if (!res.ok) return false;

    const data = await res.json();
    creds.claudeAiOauth = {
      ...oauth,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || oauth.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    await writeFile(CREDS_PATH, JSON.stringify(creds, null, 2));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const creds = JSON.parse(await readFile(CREDS_PATH, "utf-8"));
  let oauth = creds.claudeAiOauth;

  if (!oauth?.accessToken) {
    console.log(JSON.stringify({ text: "⚠ auth", tooltip: "No token. Run: claude", class: "error" }));
    return;
  }

  // Auto-refresh if expired or expiring soon
  if (oauth.expiresAt < Date.now() + REFRESH_BUFFER_MS) {
    if (await refreshToken(creds)) {
      oauth = creds.claudeAiOauth; // Use refreshed token
    } else {
      console.log(JSON.stringify({ text: "⚠ exp", tooltip: "Token expired. Run: claude", class: "error" }));
      return;
    }
  }

  const res = await fetch(API_URL, {
    headers: {
      Authorization: `Bearer ${oauth.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });

  if (!res.ok) {
    console.log(JSON.stringify({ text: "⚠ err", tooltip: `API: ${res.status}`, class: "error" }));
    return;
  }

  const data: ApiResponse = await res.json();
  const session = data.five_hour;
  const weekly = data.seven_day;

  const sessionPct = Math.round(session.utilization);
  const weeklyPct = Math.round(weekly.utilization);
  const sessionCountdown = formatCountdown(session.resets_at);
  const weeklyCountdown = formatCountdown(weekly.resets_at);

  const sessionPacing = calcPacing(sessionPct, session.resets_at, 5 * 60 * 60 * 1000);
  const weeklyPacing = calcPacing(weeklyPct, weekly.resets_at, 7 * 24 * 60 * 60 * 1000);

  const weeklyAhead = weeklyPacing.devPct;
  const cssClass =
    (weeklyAhead >= 25 || weeklyPct >= 90) ? "critical" :
    (weeklyAhead >= 10 || weeklyPct >= 75) ? "warning" : "";

  const sessionDev = Math.abs(sessionPacing.devPct);
  const weeklyDev = Math.abs(weeklyPacing.devPct);

  console.log(
    JSON.stringify({
      text: `◉${weeklyPct}% ${weeklyPacing.icon} ⧖${weeklyPacing.timeElapsedPct}% ${weeklyCountdown}`,
      tooltip: [
        "ClaudeBar",
        "─────────────────",
        `Session: ${sessionPct}% (${sessionPacing.status})`,
        `  Resets in ${sessionCountdown}`,
        "",
        `Weekly: ${weeklyPct}% (${weeklyPacing.status})`,
        `  Resets in ${weeklyCountdown}`,
      ].join("\n"),
      class: cssClass,
      percentage: sessionPct,
    })
  );
}

main().catch((e) =>
  console.log(JSON.stringify({ text: "err", tooltip: e.message, class: "error" }))
);
