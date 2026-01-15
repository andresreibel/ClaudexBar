#!/bin/bash
# ClaudeBar installer for Omarchy/Waybar
# Usage: curl -fsSL https://raw.githubusercontent.com/andresreibel/claudebar/main/install.sh | bash

set -e

SCRIPT_URL="https://raw.githubusercontent.com/andresreibel/claudebar/main/claudebar.ts"
DEST="$HOME/.config/waybar/scripts/claudebar.ts"

echo "Installing ClaudeBar..."

# Download script
mkdir -p "$(dirname "$DEST")"
curl -fsSL "$SCRIPT_URL" -o "$DEST"
chmod +x "$DEST"

echo "✓ Script installed to $DEST"
echo ""
echo "Now add to ~/.config/waybar/config.jsonc:"
echo ""
echo '  "modules-right": ["custom/claudebar", ...],'
echo ''
echo '  "custom/claudebar": {'
echo '    "exec": "bun ~/.config/waybar/scripts/claudebar.ts",'
echo '    "interval": 60,'
echo '    "return-type": "json",'
echo '    "tooltip": true,'
echo '    "on-click": "xdg-open https://claude.ai/settings/usage"'
echo '  }'
echo ""
echo "Then: omarchy-restart-waybar"
