# Troubleshooting

## `Bun was not found`

Install Bun and rerun the installer:

```sh
brew install bun
./install.sh
```

The macOS app checks `CLAUDEXBAR_BUN`, `~/.bun/bin/bun`, `/opt/homebrew/bin/bun`, and `/usr/local/bin/bun`.

## `rsvg-convert is required`

The icon build requires `librsvg`:

```sh
brew install librsvg
```

## Missing Codex credentials

Run `codex login`, then refresh ClaudexBar.

## Missing Claude credentials

Sign in with Claude Code. Linux expects `~/.claude/.credentials.json`; macOS can also read the `Claude Code-credentials` Keychain item.

## Missing or expired SpaceXAI sign-in

Select SpaceXAI and click **Sign in to SpaceXAI**. ClaudexBar opens the Cursor sign-in page only for that explicit action, stores the returned credentials at `~/.codex/claudexbar/grok-auth.json` with mode `0600`, then refreshes the Grok meter. Once authenticated, the sign-in action disappears. Missing or rejected credentials show it again; network and response errors do not claim that you are logged out.

## Claude usage returns `403`

Some organization-managed Claude accounts do not allow the Anthropic OAuth usage endpoint. ClaudexBar will show the provider error without affecting Codex. Use an account that permits OAuth usage or wait for a supported alternative usage source.

## Cached Claude usage

During temporary Claude failures or `429` backoff, ClaudexBar reuses the last valid Claude payload and marks it stale. Cache and backoff state live under `~/.codex/claudexbar/`.

## Omarchy Quattro bar is missing or stale

Ensure `~/.config/omarchy/shell.json` contains the documented `claudexbar` command widget with `"interval": 1`. The widget runs the installed engine every second, but the engine only fetches live usage about once per five minutes. Source updates take effect on the next run; restart the Omarchy shell only after changing the widget configuration.

## Rebuild the installed macOS app

Do not test against a stale menu-bar process:

```sh
pkill -x ClaudexBar || true
make install
open /Applications/ClaudexBar.app
```

Confirm the running executable:

```sh
pgrep -fl /Applications/ClaudexBar.app/Contents/MacOS/ClaudexBar
```
