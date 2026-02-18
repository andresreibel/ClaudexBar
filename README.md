# ClaudexBar

Waybar usage module for Claude + Codex with one click-to-toggle provider.

![ClaudexBar on Waybar](screenshot-2026-02-17_00-41-59.png)

<p align="center">
  <img src="screenshot-2026-02-17_00-42-11.png" alt="ClaudexBar tooltip (Claude provider)" width="360">
</p>

## What it does

- Outputs a Waybar-friendly JSON payload (`text`, `tooltip`, `class`, `percentage`).
- Supports providers:
  - `codex` (ChatGPT OAuth usage endpoint with `codex app-server` RPC fallback)
  - `claude` (Anthropic OAuth usage endpoint with automatic token refresh)
- Prefixes provider badge in bar text:
  - `A` for Claude
  - `O` for Codex

## How it works

### Provider selection

- Provider state lives in `~/.codex/claudexbar/provider` (defaults to `codex`).
- `--toggle` flips `codex` <-> `claude`.
- `--provider <name>` sets it explicitly.
- After changing provider, the script triggers a Waybar refresh via `pkill -RTMIN+11 waybar` (so your module updates immediately).

### Data sources

**Codex provider**
- Reads auth from `~/.codex/auth.json` (created by `codex login`).
- Primary path: calls the ChatGPT usage endpoint (`/wham/usage` on `chatgpt_base_url`).
- Base URL comes from `~/.codex/config.toml` (`chatgpt_base_url`), defaulting to `https://chatgpt.com/backend-api`.
- Fallback path: spawns `codex -s read-only -a untrusted app-server` and reads rate limits over RPC.

**Claude provider**
- Reads OAuth creds from `~/.claude/.credentials.json` (created by the `claude` CLI).
- If the token is near expiry, refreshes it via Anthropic OAuth.
- Calls `https://api.anthropic.com/api/oauth/usage` to get 5-hour + 7-day utilization windows.

### What you see in the bar

- The arrow (`↑ ↗ → ↘ ↓`) is a simple pace signal: usage vs time elapsed in the current window.
- The text shows weekly utilization plus a countdown to the next reset.
- The JSON `class` always includes a provider class (`provider-codex` or `provider-claude`).
- Usage color classes:
  - `warning` when weekly usage is `>= 75%` or pace is `> 1.05`
  - `critical` when weekly usage is `>= 90%` or pace is `> 1.10`
  - otherwise no usage class (neutral color, even if pace is slightly behind like `↘`)

## Commands

```bash
claudex                  # render Waybar JSON payload for current provider
claudex --toggle         # toggle provider: codex <-> claude (prints new provider)
claudex --provider claude # set provider (prints provider)
claudex --provider codex  # set provider (prints provider)

cdx                      # interactive menu (from ~/.bashrc.d/claudexbar)
cdxraw                   # raw JSON output
```

## Bash Integration

If you use `~/.bashrc.d`, create `~/.bashrc.d/claudexbar`:

```bash
claudex() {
  ~/.bun/bin/bun ~/.local/bin/claudexbar.ts "$@"
}

cdxraw() {
  claudex "$@"
}

cdxmenu() {
  local state_dir="$HOME/.codex/claudexbar"
  mkdir -p "$state_dir"
  while true; do
    local provider
    provider="$(cat "$state_dir/provider" 2>/dev/null || echo codex)"
    echo ""
    echo "Claudex Menu"
    echo "────────────"
    echo "provider: $provider"
    echo "1) toggle provider"
    echo "2) provider -> claude"
    echo "3) provider -> codex"
    echo "q) quit"
    read -rp "Select: " choice
    case "$choice" in
      1) claudex --toggle ;;
      2) claudex --provider claude ;;
      3) claudex --provider codex ;;
      q|Q) break ;;
      *) echo "Invalid choice" ;;
    esac
  done
}

cdx() {
  if [[ $# -eq 0 ]]; then
    cdxmenu
    return
  fi
  claudex "$@"
}
```

Make sure your `~/.bashrc` sources `~/.bashrc.d/*`:

```bash
for file in ~/.bashrc.d/*; do
  [[ -f "$file" ]] && source "$file"
done
```

Optional: keep a backup copy and the repo copy in sync:

```bash
cp "$HOME/.local/bin/claudexbar.ts" "$HOME/omarchy-sync/scripts/claudexbar.ts"
cp "$HOME/.local/bin/claudexbar.ts" "$HOME/Code/claudexbar/claudexbar.ts"
```

## Waybar snippet

```jsonc
"custom/claudexbar": {
  "exec": "~/.bun/bin/bun ~/.local/bin/claudexbar.ts",
  "interval": 60,
  "return-type": "json",
  "tooltip": true,
  "signal": 11,
  "on-click": "~/.bun/bin/bun ~/.local/bin/claudexbar.ts --toggle && pkill -RTMIN+11 waybar"
}
```

## State files

- `~/.codex/claudexbar/provider`

## Requirements

- Bun installed (`~/.bun/bin/bun` in snippets above).
- Waybar with `custom/claudexbar` module enabled.
- Logged in CLIs:
  - `codex login`
  - `claude` (for Claude provider usage)

## Security

- No machine-specific secrets are stored in this repo.
- Runtime auth is read from local CLI credential files (`~/.codex/auth.json`, `~/.claude/.credentials.json`), which are not tracked in git.
- The script may update those files when refreshing OAuth tokens.
