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
  "resetCredits": 1
}
```

`percentageLabel` identifies the quota window represented by the progress bar. The shared tooltip omits normal pacing prose and appends `warning` or `critical` only to the quota window that triggered that severity. `resetCredits` is optional because it is Codex-specific and is not available from every fallback source.

## Quota windows

Pacing needs a window length, because `⧖` reports how much of the window has elapsed. The three providers supply it differently:

- Codex returns `limit_window_seconds` per window, so the engine uses the reported length.
- Claude's `/api/oauth/usage` returns only `utilization` and `resets_at`, so the engine holds the lengths as constants: `CLAUDE_SESSION_WINDOW_MS` (5 hours) and `CLAUDE_WEEKLY_WINDOW_MS` (7 days).
- SpaceXAI's Cursor-backed `GetSandUsageStatus` Connect endpoint returns `usagePercent` and `nextResetTimestampUtc`; the engine maps them into the shared weekly payload shape and uses a seven-day pacing window.

Claude's weekly field is named `seven_day` and resets on a fixed account schedule. The reset day and time do not change when a subscription begins, so pacing must use the full seven-day cycle even when the implied start predates a recent signup or upgrade.

## Severity policy

The shared engine evaluates critical state before warning state. A weekly window is critical when it is more than 10% ahead of pace or at least 90% used. It is warning when it is more than 5% ahead of pace or at least 75% used. The platform adapters map warning to orange and critical to red.

## Linux adapter

Linux installs the shared engine into `~/.local/bin/claudexbar.ts`. Omarchy Quattro runs it as its built-in command widget on a short interval and reads its five-minute render cache. Its compact plain-text tooltip holds the session, weekly, reset, and refresh details; it needs no custom QML or plugin. The optional Waybar adapter runs it every five minutes and receives refresh signals on provider changes.

## macOS adapter

The Swift package contains:

- `ClaudexBarCore`: payload decoding, provider metadata, severity mapping, and macOS-only presentation cleanup.
- `claudexbar-macos`: native SwiftUI `MenuBarExtra`, refresh scheduling, provider switching, launch-at-login, and shared-engine process execution.

The packaged app bundles `claudexbar.ts` under `Contents/Resources`. The Swift app locates Bun, invokes the bundled engine off the main actor, decodes the payload, and renders it. Provider logic is not duplicated in Swift.

The macOS picker displays OpenAI, Anthropic, and SpaceXAI while preserving the engine's `codex`, `claude`, and `grok` identifiers. Selection updates immediately, clears the previous provider's usage, and shows a loading indicator until the new payload arrives.

The shared payload optionally carries `authenticationRequired`. The engine sets it to `true` only when Grok credentials are missing or rejected with `401`, sets it to `false` after successful live usage, and omits it for unrelated failures. Swift shows the **Sign in** action only for explicit `true`; it never inspects credentials or parses error text.

## Credentials

- Codex uses `~/.codex/auth.json`.
- Claude uses `~/.claude/.credentials.json` when available.
- On macOS, Claude falls back to the `Claude Code-credentials` Keychain item.
- SpaceXAI uses ClaudexBar-owned `~/.codex/claudexbar/grok-auth.json`, written atomically with mode `0600` after an explicit PKCE sign-in. The browser opens only for that user action; normal refreshes never initiate login. Grok usage requests have a 10-second timeout, and missing or rejected credentials require explicit reconnection.

Credential values must never appear in tests, logs, screenshots, documentation, or Git history.

## Build and install

`Makefile` builds the Swift release executable, generates the icon, creates the `.app` bundle, embeds the shared engine, and ad-hoc signs the bundle. `install.sh` selects this path on Darwin and installs the shared Linux engine; Quattro and optional Waybar supply the bar adapter.
