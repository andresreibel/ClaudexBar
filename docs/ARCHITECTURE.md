# Architecture

ClaudexBar is one product with a shared provider engine and thin platform adapters.

## Shared engine

`claudexbar.ts` owns:

- Codex and Claude credential loading, plus SpaceXAI PKCE sign-in and private credential storage.
- Provider usage requests and Codex RPC fallback.
- Session and weekly quota parsing.
- Pacing, warning state, reset countdowns, and reset-credit formatting.
- Claude caching and rate-limit backoff.
- Provider selection under `~/.codex/claudexbar/`.

It emits a JSON payload consumed by the Quattro command widget and the optional Waybar adapter:

```json
{
  "text": "O(1) ↑ ◉78% ⧖60%",
  "tooltip": "Session 2% · reset 4h55m\nWeek 78% · warning · reset 2d9h\nUpdated: 07:34 PM",
  "class": ["warning", "provider-codex"],
  "percentage": 2,
  "percentageLabel": "Session",
  "resetCredits": 1,
  "usageRows": [
    {"label": "Session", "percentage": 2, "resetText": "4h55m", "severity": "normal", "pacing": {"expectedPercentage": 1}},
    {"label": "Weekly", "percentage": 78, "resetText": "2d9h", "severity": "warning", "pacing": {"expectedPercentage": 60}}
  ]
}
```

`percentage` and `percentageLabel` retain the compact cross-platform compatibility field. `usageRows` is the ordered native detail contract: the shared engine owns labels, actual percentages, expected percentages, reset countdowns, and per-row severity, while Swift renders paired progress bars. Expected usage is the rounded share of the real quota window that has elapsed; monthly Cursor rows use the returned billing-cycle start and end rather than a calendar approximation. The shared tooltip omits normal pacing prose and appends `warning` or `critical` only to the quota window that triggered that severity. `resetCredits` is optional because it is Codex-specific and is not available from every fallback source.

The macOS app invokes `claudexbar.ts --all`. That additive response wraps one unchanged payload per provider in fixed Anthropic, OpenAI, SpaceXAI order and includes `weeklyPace`, calculated as expected weekly percentage minus actual weekly percentage. Each provider reads or refreshes its own existing cache independently. The normal no-argument engine output and persisted provider selection remain unchanged for Linux.

## Quota windows

Pacing needs a window length, because `⧖` reports how much of the window has elapsed. The three providers supply it differently:

- Codex returns `limit_window_seconds` per window, so the engine uses the reported length.
- Claude's `/api/oauth/usage` returns only `utilization` and `resets_at`, so the engine holds the lengths as constants: `CLAUDE_SESSION_WINDOW_MS` (5 hours) and `CLAUDE_WEEKLY_WINDOW_MS` (7 days).
- SpaceXAI's Cursor-backed `GetCurrentPeriodUsage` Connect endpoint supplies the Cursor Models (Monthly) and Other Models (Monthly) percentages and billing-cycle reset. `GetSandUsageStatus` supplies GrokBot (Weekly) usage and its next reset; the engine uses a seven-day pacing window for that row.

Claude's weekly field is named `seven_day` and resets on a fixed account schedule. The reset day and time do not change when a subscription begins, so pacing must use the full seven-day cycle even when the implied start predates a recent signup or upgrade.

## Severity policy

The shared engine derives severity independently for every quota row. Actual usage at or below expected is normal; usage above expected but less than 10% over pace is warning; usage at least 10% over pace is critical. The platform adapters map warning to cosmic orange (`#ff9e64`) and critical to red.

## Linux adapter

Linux installs the shared engine into `~/.local/bin/claudexbar.ts`. Omarchy Quattro runs it as its built-in command widget on a short interval and reads its five-minute render cache. Its compact plain-text tooltip holds the session, weekly, reset, and refresh details; it needs no custom QML or plugin. The optional Waybar adapter runs it every five minutes and receives refresh signals on provider changes.

## macOS adapter

![ClaudexBar macOS dashboard on a MacBook](../assets/claudexbar-macos.png)

The Swift package contains:

- `ClaudexBarCore`: single-provider and aggregate payload decoding, provider metadata, signed pace formatting, severity mapping, and macOS-only presentation cleanup.
- `claudexbar-macos`: native SwiftUI content hosted in an `NSPopover`, a variable-width `NSStatusItem`, refresh scheduling, SpaceXAI sign-in, and shared-engine process execution.

The packaged app bundles `claudexbar.ts` under `Contents/Resources`. The Swift app locates Bun, invokes `--all` off the main actor, decodes the aggregate payload, and renders all providers. Provider logic is not duplicated in Swift.

The menu bar displays signed weekly pace for connected Anthropic, OpenAI, and SpaceXAI accounts. The popover renders all three fixed columns, including disconnected providers; provider selection remains a Linux-only interaction. Missing credentials or an unauthorized response set `authenticationRequired`, remove only that provider from the menu-bar title, and expose **Reconnect** in its column. Temporary network, rate-limit, and organization-policy errors remain visible without being mislabeled as disconnected.

The shared payload optionally carries `authenticationRequired`. SpaceXAI reconnect uses its existing PKCE flow. Anthropic and OpenAI reconnect launch their installed CLI authentication commands, then refresh all provider payloads after successful completion. Swift never inspects credential files or parses error text.

## Credentials

- Codex uses `~/.codex/auth.json`.
- Claude uses `~/.claude/.credentials.json` when available.
- On macOS, Claude falls back to the `Claude Code-credentials` Keychain item.
- SpaceXAI uses ClaudexBar-owned `~/.codex/claudexbar/grok-auth.json`, written atomically with mode `0600` after an explicit PKCE sign-in. The browser opens only for that user action; normal refreshes never initiate login. Grok usage requests have a 10-second timeout, and missing or rejected credentials require explicit reconnection.

Credential values must never appear in tests, logs, screenshots, documentation, or Git history.

## Build and install

`Makefile` builds the Swift release executable, generates the icon, creates the `.app` bundle, embeds the shared engine, and ad-hoc signs the bundle. `install.sh` selects this path on Darwin and installs the shared Linux engine; Quattro and optional Waybar supply the bar adapter.
