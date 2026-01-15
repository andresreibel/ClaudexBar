# ClaudeBar

> Your Claude Max usage, always visible. Never hit rate limits by surprise.

![ClaudeBar on Omarchy](screenshot-desktop.png)

<p align="center">
  <img src="screenshot-tooltip.png" alt="ClaudeBar tooltip" width="360">
</p>

## Quick Install (Omarchy)

```bash
curl -fsSL https://raw.githubusercontent.com/andresreibel/claudebar/main/install.sh | bash
```

Then add to your waybar config and restart:

```bash
omarchy-restart-waybar
```

## Manual Install

**Step 1:** Copy the script

```bash
curl -o ~/.config/waybar/scripts/claudebar.ts \
  https://raw.githubusercontent.com/andresreibel/claudebar/main/claudebar.ts
```

**Step 2:** Add to `~/.config/waybar/config.jsonc`

```jsonc
"modules-right": ["custom/claudebar", ...],

"custom/claudebar": {
  "exec": "bun ~/.config/waybar/scripts/claudebar.ts",
  "interval": 60,
  "return-type": "json",
  "tooltip": true,
  "on-click": "xdg-open https://claude.ai/settings/usage"
}
```

**Step 3:** Restart waybar

```bash
killall waybar && waybar &
# Or on Omarchy: omarchy-restart-waybar
```

## What It Shows

```
W3% S3% ↓ 4h08m
│   │   │  └── Resets in 4h 8m
│   │   └───── ↓ under / → on track / ↑ ahead
│   └───────── Session: 3% of 5-hour window
└───────────── Weekly: 3% of 7-day limit
```

## Requirements

- [Bun](https://bun.sh/) — `curl -fsSL https://bun.sh/install | bash`
- [Claude CLI](https://github.com/anthropics/claude-code) — must be logged in
- Claude Max subscription

## Why This Approach?

- **No API keys** — Uses OAuth token from Claude CLI (`~/.claude/.credentials.json`)
- **Official API** — Calls `api.anthropic.com/api/oauth/usage` for exact data
- **Single file** — One 100-line TypeScript script, no dependencies beyond Bun
- **Waybar native** — Outputs JSON that Waybar understands natively

## Troubleshooting

| Shows | Fix |
|-------|-----|
| `⚠ auth` | Run `claude` to log in |
| `⚠ exp` | Run `claude` to refresh token |
| `⚠ err` | Check network connection |

## Color Coding (Optional)

Add to `~/.config/waybar/style.css`:

```css
#custom-claudebar.over  { color: #e06c75; }
#custom-claudebar.under { color: #98c379; }
```

## Related

- [Waybar](https://github.com/Alexays/Waybar) — Highly customizable status bar for Wayland
- [CodexBar](https://github.com/steipete/CodexBar) — Usage meter for macOS (inspiration)
- [Omarchy](https://omarchy.org/) — Beautiful Linux with Hyprland

## Thanks

- [Peter Steinberger](https://github.com/steipete) — CodexBar inspiration
- [DHH](https://github.com/dhh) — Omarchy & O'Saasy license

## License

[O'Saasy](https://osaasy.dev/)
