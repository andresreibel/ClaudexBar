# AGENTS.md

## Contract

ClaudexBar is one cross-platform product with one shared quota engine.

- `claudexbar.ts` owns Codex/Claude auth, usage, pacing, caching, and payload behavior.
- Linux uses the shared engine through an Omarchy Quattro command widget or the optional Waybar integration.
- macOS uses a thin native SwiftUI menu-bar shell that bundles and invokes the same engine.
- Keep platform-specific UI and installation code thin; do not duplicate provider logic in Swift.
- `install.sh` must detect Darwin versus Linux and preserve existing Linux options and behavior.
- Do not deploy, publish releases, push, or change secrets without explicit approval.

## macOS Testing

Build and test before installing:

```sh
make test
make app
```

Installed-app tests are valid only after rebuilding and reinstalling:

```sh
pkill -x ClaudexBar || true
make install
open /Applications/ClaudexBar.app
```

The running process must be `/Applications/ClaudexBar.app/Contents/MacOS/ClaudexBar`.
