#!/usr/bin/env bun
/**
 * ClaudeBar - Claude Max usage meter for Waybar
 * https://github.com/andresreibel/claudebar
 *
 * Uses official Claude OAuth API for exact usage data.
 * Requires: bun, Claude CLI logged in (~/.claude/.credentials.json)
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

  // Pacing: compare usage% vs time elapsed%
  const msLeft = new Date(session.resets_at).getTime() - Date.now();
  const sessionMs = 5 * 60 * 60 * 1000; // 5 hours
  const timeElapsedPct = ((sessionMs - msLeft) / sessionMs) * 100;
  const pacing = timeElapsedPct > 0 ? sessionPct / timeElapsedPct : 0;

  // Pacing indicator: ↑ over, ↓ under, → on track
  let pacingIcon = "→";
  let pacingStatus = "on track";
  if (pacing > 1.2) {
    pacingIcon = "↑";
    pacingStatus = `${Math.round((pacing - 1) * 100)}% ahead`;
  } else if (pacing < 0.8) {
    pacingIcon = "↓";
    pacingStatus = `${Math.round((1 - pacing) * 100)}% under`;
  }

  const cssClass = sessionPct > 80 ? "over" : sessionPct < 30 ? "under" : "normal";

  console.log(
    JSON.stringify({
      text: `W${weeklyPct}% S${sessionPct}% ${pacingIcon} ${sessionCountdown}`,
      tooltip: [
        "ClaudeBar",
        "─────────────────",
        `Session: ${sessionPct}% (${pacingStatus})`,
        `  Resets in ${sessionCountdown}`,
        "",
        `Weekly: ${weeklyPct}%`,
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
