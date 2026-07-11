# Architecture

ClaudexBar is one product with a shared provider engine and thin platform adapters.

## Shared engine

`claudexbar.ts` owns:

- Codex and Claude credential loading and refresh.
- Provider usage requests and Codex RPC fallback.
- Session and weekly quota parsing.
- Pacing, warning state, reset countdowns, and reset-credit formatting.
- Claude caching and rate-limit backoff.
- Provider selection under `~/.codex/claudexbar/`.

It emits a Waybar-compatible JSON payload:

```json
{
  "text": "O(1) → ◉1% ⧖1% 6d22h",
  "tooltip": "Provider: Codex (oauth)\n...",
  "class": ["provider-codex"],
  "percentage": 9,
  "resetCredits": 1
}
```

`resetCredits` is optional because it is Codex-specific and is not available from every fallback source.

## Linux adapter

Linux installs the shared engine into `~/.local/bin/claudexbar.ts`. Waybar executes it every five minutes and consumes the JSON payload directly. Provider changes signal Waybar to refresh.

## macOS adapter

The Swift package contains:

- `ClaudexBarCore`: payload decoding, provider metadata, severity mapping, and macOS-only presentation cleanup.
- `claudexbar-macos`: native SwiftUI `MenuBarExtra`, refresh scheduling, provider switching, launch-at-login, and shared-engine process execution.

The packaged app bundles `claudexbar.ts` under `Contents/Resources`. The Swift app locates Bun, invokes the bundled engine off the main actor, decodes the payload, and renders it. Provider logic is not duplicated in Swift.

## Credentials

- Codex uses `~/.codex/auth.json`.
- Claude uses `~/.claude/.credentials.json` when available.
- On macOS, Claude falls back to the `Claude Code-credentials` Keychain item.

Credential values must never appear in tests, logs, screenshots, documentation, or Git history.

## Build and install

`Makefile` builds the Swift release executable, generates the icon, creates the `.app` bundle, embeds the shared engine, and ad-hoc signs the bundle. `install.sh` selects this path on Darwin and the established CLI/Waybar path on Linux.
