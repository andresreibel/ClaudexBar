# ClaudexBar

ClaudexBar keeps Codex and Claude subscription limits visible on macOS and Linux without opening either dashboard.

One shared TypeScript engine owns authentication, quota fetching, pacing, reset countdowns, caching, and fallbacks. macOS renders it through a native SwiftUI menu-bar app; Linux renders the same payload through Waybar.

![ClaudexBar on Waybar](screenshot-2026-02-17_00-41-59.png)

## Features

- Codex and Claude provider switching.
- Session and weekly utilization with reset countdowns.
- Pace indicators showing whether usage is ahead of or under the current quota window.
- Codex free reset-credit count in the menu bar and macOS dropdown.
- Five-minute refresh, manual refresh, caching, and rate-limit backoff.
- Native macOS launch-at-login control.
- The same warning (`#ff9e64`) and critical (`#f7768e`) status colors on macOS and Waybar.
- Automatic macOS/Linux installer routing.

## Display

Example:

```text
O(1) → ◉1% ⧖1% 6d22h
```

| Part | Meaning |
| --- | --- |
| `O` / `A` | OpenAI Codex / Anthropic Claude |
| `(1)` | Available Codex free reset credits |
| `↑ ↗ → ↘ ↓` | Usage pace versus elapsed quota-window time |
| `◉1%` | Weekly utilization |
| `⧖1%` | Elapsed weekly quota window |
| `6d22h` | Time until weekly reset |

## Install

Clone the repository and run the same installer on either platform:

```sh
git clone https://github.com/andresreibel/ClaudexBar.git
cd ClaudexBar
./install.sh
```

The installer uses `uname`:

- macOS builds and installs `/Applications/ClaudexBar.app`.
- Linux installs `~/.local/bin/claudexbar.ts`.

### macOS

Requirements:

- macOS 14 or newer.
- Xcode Command Line Tools / Swift.
- Bun.
- `librsvg` for the app icon build.

```sh
xcode-select --install  # only when Swift is missing
brew install bun librsvg
./install.sh
open /Applications/ClaudexBar.app
```

The app is currently built from source and ad-hoc signed. There is no notarized downloadable build yet.

### Linux / Waybar

Install Bun, then add the CLI plus shell and Waybar integrations:

```sh
./install.sh --all
```

Or install integrations separately:

```sh
./install.sh --bashrc
./install.sh --waybar
```

Commands:

```sh
claudex
claudex --toggle
claudex --provider claude
claudex --provider codex
```

## Authentication and state

ClaudexBar reuses existing CLI credentials; it never stores credentials in the repository or application bundle.

- Codex: `~/.codex/auth.json`.
- Claude on Linux: `~/.claude/.credentials.json`.
- Claude on macOS: the credentials file when present, otherwise the `Claude Code-credentials` Keychain item.
- Provider selection and caches: `~/.codex/claudexbar/`.

The shared engine may refresh existing OAuth credentials when required. Some Anthropic organizations reject the OAuth usage endpoint with `403`; see [troubleshooting](docs/TROUBLESHOOTING.md).

## Development

```sh
make test
make app
make install
open /Applications/ClaudexBar.app
```

Verification covers Swift payload decoding, macOS presentation, Keychain decoding, TypeScript compilation, packaging, and the installed bundle.

See [architecture](docs/ARCHITECTURE.md), [troubleshooting](docs/TROUBLESHOOTING.md), and the [changelog](CHANGELOG.md).

## Current verification

- macOS native app: built, installed, signed, launched, and live Codex usage verified.
- Codex free reset credits: verified against `rate_limit_reset_credits.available_count`.
- Claude macOS Keychain discovery: verified.
- Claude live usage: account-dependent; the current OAuth endpoint can reject organization-managed accounts.
- Linux/Waybar: existing integration preserved; CI validates the shared engine and installer syntax.

## License

See [LICENSE](LICENSE).
