#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${CLAUDEXBAR_REPO_DIR:-$SCRIPT_DIR}"
INSTALL_BASHRC=0
INSTALL_WAYBAR=0
FORCE_BASHRC=0

usage() {
  cat <<'EOF'
Install ClaudexBar

Usage:
  install.sh [options]

Options:
  --bashrc        Install ~/.bashrc.d/claudexbar helper functions
  --waybar        Install/patch Waybar module + style
  --all           Equivalent to: --bashrc --waybar
  --source <dir>  Source repo directory (default: install.sh directory)
  --force-bashrc  Overwrite ~/.bashrc.d/claudexbar if it already exists
  -h, --help      Show this help

Examples:
  ./install.sh
  ./install.sh --bashrc
  ./install.sh --waybar
  ./install.sh --all
EOF
}

backup_if_exists() {
  local file="$1"
  if [[ -f "$file" ]]; then
    cp "$file" "${file}.bak.$(date +%Y%m%d-%H%M%S)"
  fi
}

resolve_repo_dir() {
  if [[ ! -f "$REPO_DIR/claudexbar.ts" && -f "$HOME/Code/claudexbar/claudexbar.ts" ]]; then
    REPO_DIR="$HOME/Code/claudexbar"
  fi
  if [[ ! -f "$REPO_DIR/claudexbar.ts" && -f "$HOME/Code/Claudexbar/claudexbar.ts" ]]; then
    REPO_DIR="$HOME/Code/Claudexbar"
  fi

  if [[ ! -f "$REPO_DIR/claudexbar.ts" ]]; then
    echo "Could not find claudexbar.ts in:"
    echo "  $SCRIPT_DIR"
    echo "  $HOME/Code/claudexbar"
    echo "  $HOME/Code/Claudexbar"
    echo "Set CLAUDEXBAR_REPO_DIR or pass --source <dir>."
    exit 1
  fi
}

install_script() {
  mkdir -p "$HOME/.local/bin"
  cp "$REPO_DIR/claudexbar.ts" "$HOME/.local/bin/claudexbar.ts"
  chmod +x "$HOME/.local/bin/claudexbar.ts"
  echo "Installed: ~/.local/bin/claudexbar.ts"
  echo "Source:    $REPO_DIR/claudexbar.ts"
}

install_bashrc_integration() {
  local target="$HOME/.bashrc.d/claudexbar"
  mkdir -p "$HOME/.bashrc.d"

  if [[ -f "$target" && "$FORCE_BASHRC" -ne 1 ]]; then
    echo "Skip bashrc integration: $target already exists (use --force-bashrc to overwrite)"
    return
  fi

  backup_if_exists "$target"
  cat > "$target" <<'EOF'
# ClaudexBar shortcuts

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
    echo "4) refresh -> waybar"
    echo "q) quit"
    echo ""
    read -rp "Select: " choice
    case "$choice" in
      1) claudex --toggle ;;
      2) claudex --provider claude ;;
      3) claudex --provider codex ;;
      4) pkill -RTMIN+11 waybar 2>/dev/null || true ;;
      q|Q) break ;;
      *) echo "Invalid choice" ;;
    esac
  done
}

unalias cdx 2>/dev/null || true
cdx() {
  if [[ $# -eq 0 ]]; then
    cdxmenu
    return
  fi
  claudex "$@"
}
EOF

  echo "Installed bashrc integration: $target"
  if ! grep -qE 'source .*~/.bashrc.d|for file in ~/.bashrc.d/\*' "$HOME/.bashrc" 2>/dev/null; then
    echo "Note: ensure ~/.bashrc sources ~/.bashrc.d/*"
  fi
}

install_waybar_integration() {
  local config="$HOME/.config/waybar/config.jsonc"
  local style="$HOME/.config/waybar/style.css"

  if [[ ! -f "$config" ]]; then
    echo "Skip waybar integration: missing $config"
    return
  fi

  backup_if_exists "$config"
  if [[ -f "$style" ]]; then
    backup_if_exists "$style"
  fi

  if ! grep -q '"custom/claudexbar"' "$config"; then
    local tmp_config
    tmp_config="$(mktemp)"
    awk '
      BEGIN { inserted = 0 }
      /"modules-right"[[:space:]]*:[[:space:]]*\[/ && inserted == 0 {
        print
        print "    \"custom/claudexbar\","
        inserted = 1
        next
      }
      { print }
    ' "$config" > "$tmp_config"
    mv "$tmp_config" "$config"

    tmp_config="$(mktemp)"
    awk '
      BEGIN { inserted_block = 0 }
      /^[[:space:]]*}[[:space:]]*$/ && inserted_block == 0 {
        print "  ,\"custom/claudexbar\": {"
        print "    \"exec\": \"~/.bun/bin/bun ~/.local/bin/claudexbar.ts\","
        print "    \"interval\": 60,"
        print "    \"return-type\": \"json\","
        print "    \"tooltip\": true,"
        print "    \"signal\": 11,"
        print "    \"on-click\": \"~/.bun/bin/bun ~/.local/bin/claudexbar.ts --toggle && pkill -RTMIN+11 waybar\""
        print "  }"
        inserted_block = 1
      }
      { print }
    ' "$config" > "$tmp_config"
    mv "$tmp_config" "$config"
  fi

  if [[ -f "$style" ]] && ! grep -q '#custom-claudexbar' "$style"; then
    cat >> "$style" <<'EOF'

# ClaudexBar
#custom-claudexbar {
  margin: 0 7.5px;
}

#custom-claudexbar.warning {
  color: #ff9e64;
}

#custom-claudexbar.critical {
  color: #f7768e;
}

#custom-claudexbar.easy {
  color: #e0af68;
}
EOF
  fi

  pkill -RTMIN+11 waybar 2>/dev/null || true
  echo "Installed waybar integration"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bashrc)
      INSTALL_BASHRC=1
      shift
      ;;
    --waybar)
      INSTALL_WAYBAR=1
      shift
      ;;
    --all)
      INSTALL_BASHRC=1
      INSTALL_WAYBAR=1
      shift
      ;;
    --source)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --source"
        exit 1
      fi
      REPO_DIR="$2"
      shift 2
      ;;
    --force-bashrc)
      FORCE_BASHRC=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

resolve_repo_dir
install_script

if [[ "$INSTALL_BASHRC" -eq 1 ]]; then
  install_bashrc_integration
fi

if [[ "$INSTALL_WAYBAR" -eq 1 ]]; then
  install_waybar_integration
fi
