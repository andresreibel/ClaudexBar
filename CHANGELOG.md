# Changelog

## Unreleased

### Added

- SpaceXAI (Grok) as a third provider on macOS and Linux, with explicit PKCE sign-in, atomically stored private credentials, bounded Cursor-backed weekly usage/reset requests, and redacted reconnect guidance.

### Fixed

- Show the SpaceXAI sign-in action only when Grok credentials are missing or rejected; authenticated accounts no longer display a redundant reconnect button.
- Removed reset countdowns from the compact bar summary. Session and weekly reset times remain in the detail view, including cached Claude usage.
- Compacted the Linux Quattro detail tooltip while retaining session, weekly, reset, and refresh information.
- Claude weekly elapsed-window percentage and pace arrow. The `seven_day` usage field is a 72-hour window, not seven days, so the previous 7-day assumption reported a window that began days before the account existed and overstated elapsed time by roughly 13x.

## 0.3.0 - 2026-07-11

### Added

- Native SwiftUI menu-bar app for macOS 14+.
- Linux Waybar warning and critical color behavior in the native macOS status item.
- Higher-contrast macOS critical red with semibold status glyphs.
- Limited macOS severity color to the pace arrow so every other menu-bar element retains native contrast.
- One installer that detects macOS or Linux and installs the correct platform integration.
- Shared JSON payload contract between the TypeScript engine and SwiftUI app.
- Codex free reset-credit count in the menu bar (`O(1)`) and macOS dropdown.
- macOS Keychain fallback for Claude Code credentials, including hex-encoded Keychain data.
- Provider selector, manual refresh, five-minute refresh, launch-at-login, and native app packaging.
- Subtle last-updated time in the macOS dropdown and Linux tooltip.
- Swift and Bun unit tests, app icon generation, and cross-platform CI.

### Changed

- Kept `claudexbar.ts` as the single provider/auth/quota engine for both platforms.
- Limited Waybar refresh signals to Linux.
- Simplified macOS detail presentation so headings and reset credits are not duplicated.
- Expanded documentation for installation, display notation, credentials, architecture, and troubleshooting.

### Known limitations

- macOS builds are ad-hoc signed and must currently be built from source.
- Anthropic may reject the OAuth usage endpoint for some organization-managed accounts.
