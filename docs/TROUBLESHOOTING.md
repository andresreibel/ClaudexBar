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

In the SpaceXAI column, click **Reconnect**. ClaudexBar opens the Cursor sign-in page only for that explicit action, stores the returned credentials at `~/.codex/claudexbar/grok-auth.json` with mode `0600`, then refreshes all three columns. Once authenticated, the action disappears. Missing or rejected credentials show it again; network and response errors do not claim that you are logged out.

## Missing Anthropic or OpenAI sign-in

Click **Reconnect** in the disconnected provider's column. ClaudexBar runs `claude auth login` for Anthropic or `codex login` for OpenAI; complete the browser flow and the app refreshes all providers. A disconnected provider is omitted from the menu bar until authentication succeeds.

## Claude usage returns `403`

Some organization-managed Claude accounts do not allow the Anthropic OAuth usage endpoint. ClaudexBar will show the provider error without affecting Codex. Use an account that permits OAuth usage or wait for a supported alternative usage source.

## Cached Claude usage

During temporary Claude failures or `429` backoff, ClaudexBar reuses the last valid Claude payload and marks it stale. Cache and backoff state live under `~/.codex/claudexbar/`.

## Omarchy Quattro bar is missing or stale

Ensure `~/.config/omarchy/shell.json` contains the documented `claudexbar` command widget with `"interval": 1`. The widget runs the installed engine every second, but the engine only fetches live usage about once per five minutes. Source updates take effect on the next run; restart the Omarchy shell only after changing the widget configuration.

## Linux dashboard does not open

Run the installed adapter from a terminal:

```sh
~/.local/bin/claudexbar-dashboard
```

Install Python 3, GTK 4, and PyGObject if it reports a missing GTK runtime. On Wayland, install `gtk4-layer-shell` for the anchored top-right popover; the dashboard still works as a normal GTK window without it. Confirm the Quattro click command is `~/.local/bin/claudexbar-dashboard`, then rerun `./install.sh` after source updates.

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
