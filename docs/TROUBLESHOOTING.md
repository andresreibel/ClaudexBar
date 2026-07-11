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

## Claude usage returns `403`

Some organization-managed Claude accounts do not allow the Anthropic OAuth usage endpoint. ClaudexBar will show the provider error without affecting Codex. Use an account that permits OAuth usage or wait for a supported alternative usage source.

## Cached Claude usage

During temporary Claude failures or `429` backoff, ClaudexBar reuses the last valid Claude payload and marks it stale. Cache and backoff state live under `~/.codex/claudexbar/`.

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
