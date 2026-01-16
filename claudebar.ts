#!/usr/bin/env bun
/**
 * ClaudeBar - Claude usage meter for Waybar
 * Uses official Claude OAuth API for exact usage data
 */

import { readFile } from "fs/promises";
import { homedir } from "os";

const CREDS_PATH = `${homedir()}/.claude/.credentials.json`;
const API_URL = "https://api.anthropic.com/api/oauth/usage";

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

function calcPacing(usagePct: number, resetAt: string, windowMs: number): { icon: string; status: string } {
  const msLeft = new Date(resetAt).getTime() - Date.now();
  const timeElapsedPct = ((windowMs - msLeft) / windowMs) * 100;
  const pacing = timeElapsedPct > 0 ? usagePct / timeElapsedPct : 0;
  if (pacing > 1.2) return { icon: "↑", status: `${Math.round((pacing - 1) * 100)}% ahead` };
  if (pacing < 0.8) return { icon: "↓", status: `${Math.round((1 - pacing) * 100)}% under` };
  return { icon: "→", status: "on track" };
}

async function main() {
  const creds = JSON.parse(await readFile(CREDS_PATH, "utf-8"));
  const oauth = creds.claudeAiOauth;

  if (!oauth?.accessToken) {
    console.log(JSON.stringify({ text: "⚠ auth", tooltip: "No token. Run: claude", class: "error" }));
    return;
  }

  if (oauth.expiresAt < Date.now()) {
    console.log(JSON.stringify({ text: "⚠ exp", tooltip: "Token expired. Run: claude", class: "error" }));
    return;
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

  const maxPct = Math.max(sessionPct, weeklyPct);
  const cssClass = maxPct >= 90 ? "critical" : maxPct >= 75 ? "warning" : "";

  console.log(
    JSON.stringify({
      text: `${sessionPacing.icon}S${sessionPct}% ${weeklyPacing.icon}W${weeklyPct}% ${sessionCountdown}`,
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
