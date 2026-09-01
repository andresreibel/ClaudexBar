#!/usr/bin/env python3

import ctypes.util
import json
import os
import shutil
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

if os.environ.get("WAYLAND_DISPLAY") and not os.environ.get("CLAUDEXBAR_LAYER_REEXEC"):
    layer_shell = ctypes.util.find_library("gtk4-layer-shell")
    if layer_shell:
        environment = os.environ.copy()
        preload = environment.get("LD_PRELOAD")
        environment["LD_PRELOAD"] = f"{layer_shell}:{preload}" if preload else layer_shell
        environment["CLAUDEXBAR_LAYER_REEXEC"] = "1"
        os.execvpe(sys.executable, [sys.executable, *sys.argv], environment)

try:
    import gi

    gi.require_version("Gtk", "4.0")
    from gi.repository import Gio, GLib, Gtk
except (ImportError, ValueError) as error:
    raise SystemExit(
        "ClaudexBar dashboard requires GTK 4 and PyGObject. "
        "Install python-gobject and gtk4 for your distribution."
    ) from error

try:
    gi.require_version("Gtk4LayerShell", "1.0")
    from gi.repository import Gtk4LayerShell
except (ImportError, ValueError):
    Gtk4LayerShell = None

PROVIDERS = {
    "claude": ("A", "Anthropic"),
    "codex": ("O", "OpenAI"),
    "grok": ("S", "SpaceXAI"),
}

CSS = """
window.claudexbar-window {
  background: rgba(22, 22, 25, 0.97);
  color: #f4f4f5;
}
.claudexbar-root {
  padding: 16px 16px 24px;
}
.app-title {
  font-size: 15px;
  font-weight: 700;
}
.icon-button {
  min-width: 24px;
  min-height: 24px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #e4e4e7;
}
.icon-button:hover {
  background: rgba(255, 255, 255, 0.08);
}
.provider-card {
  min-width: 164px;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.055);
}
.provider-badge {
  min-width: 30px;
  min-height: 30px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.09);
  font-size: 12px;
  font-weight: 800;
}
.provider-name {
  font-size: 15px;
  font-weight: 700;
}
.pace {
  margin-top: 2px;
  font-family: monospace;
  font-size: 32px;
  font-weight: 700;
}
.pace-positive { color: #3ddc84; }
.pace-negative { color: #ff9565; }
.pace-neutral { color: #a1a1aa; }
.pace-caption {
  color: #a1a1aa;
  font-size: 10px;
  font-weight: 700;
}
.usage-label, .usage-value, .credits-label, .credits-value {
  color: #c5c5cb;
  font-size: 12px;
  font-weight: 650;
}
.usage-value, .credits-value {
  font-family: monospace;
}
.expected-label, .expected-value, .reset-label, .updated-label, .detail-label {
  color: #777780;
  font-size: 11px;
}
.expected-value, .reset-label, .updated-label, .detail-label {
  font-family: monospace;
}
.detail-error { color: #f7768e; }
progressbar {
  min-height: 6px;
}
progressbar > trough {
  min-height: 6px;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
}
progressbar > trough > progress {
  min-width: 0;
  min-height: 6px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: #7aa2f7;
}
progressbar.severity-warning > trough > progress { background: #ff9e64; }
progressbar.severity-critical > trough > progress,
progressbar.severity-error > trough > progress { background: #f7768e; }
progressbar.expected > trough > progress { background: #8b8b94; }
.reconnect-button {
  margin-top: 4px;
  padding: 5px 10px;
  border-radius: 7px;
}
.error-banner {
  color: #f7768e;
  font-size: 11px;
}
"""


def find_bun():
    override = os.environ.get("CLAUDEXBAR_BUN")
    candidates = [override, str(Path.home() / ".bun/bin/bun"), shutil.which("bun")]
    return next((candidate for candidate in candidates if candidate and os.access(candidate, os.X_OK)), None)


def find_engine():
    override = os.environ.get("CLAUDEXBAR_ENGINE")
    candidates = [override, str(Path(__file__).with_name("claudexbar.ts"))]
    return next((candidate for candidate in candidates if candidate and Path(candidate).is_file()), None)


def compact_label(label):
    return {
        "Cursor Models (Monthly)": "Cursor monthly",
        "Other Models (Monthly)": "Other monthly",
        "GrokBot (Weekly)": "GrokBot weekly",
    }.get(label, label)


def format_number(value):
    number = float(value)
    return str(int(number)) if number.is_integer() else f"{number:.1f}"


def updated_text(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone()
        return parsed.strftime("%I:%M %p").lstrip("0")
    except (TypeError, ValueError):
        return None


def residual_detail(payload):
    rows = payload.get("usageRows") or []
    labels = {row.get("label") for row in rows}
    details = []
    for line in str(payload.get("tooltip") or "").splitlines():
        if line.startswith("Updated:") or line.startswith("Credits "):
            continue
        if line.startswith("Session ") and "Session" in labels and "unavailable" not in line.lower():
            continue
        if line.startswith("Week ") and any("Weekly" in str(label) for label in labels):
            continue
        if line.strip():
            details.append(line.strip())
    return "\n".join(details[:3])


class ProviderCard(Gtk.Box):
    def __init__(self, provider, reconnect):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.provider = provider
        self.reconnect = reconnect
        self.add_css_class("provider-card")
        self.set_hexpand(True)
        self.set_vexpand(True)
        self.render(None)

    def clear(self):
        child = self.get_first_child()
        while child is not None:
            next_child = child.get_next_sibling()
            self.remove(child)
            child = next_child

    def render(self, entry):
        self.clear()
        badge, name = PROVIDERS[self.provider]

        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        badge_label = Gtk.Label(label=badge)
        badge_label.add_css_class("provider-badge")
        header.append(badge_label)
        name_label = Gtk.Label(label=name, xalign=0)
        name_label.add_css_class("provider-name")
        header.append(name_label)
        self.append(header)

        pace = None if entry is None else entry.get("weeklyPace")
        pace_label = Gtk.Label(label="--" if pace is None else f"{float(pace):+.0f}%", xalign=0)
        pace_label.add_css_class("pace")
        pace_label.add_css_class("pace-negative" if pace is not None and pace < 0 else "pace-positive" if pace is not None and pace > 0 else "pace-neutral")
        self.append(pace_label)

        caption = Gtk.Label(label="Weekly pace (expected − actual)", xalign=0)
        caption.set_ellipsize(3)
        caption.add_css_class("pace-caption")
        self.append(caption)

        if entry is None:
            loading = Gtk.Label(label="Loading usage…", xalign=0)
            loading.add_css_class("detail-label")
            self.append(loading)
            self.append(Gtk.Box(vexpand=True))
            return

        payload = entry.get("payload") or {}
        rows = payload.get("usageRows") or []
        if rows:
            for row in rows:
                self.append(self.usage_row(row))
        elif payload.get("percentage") is not None:
            self.append(self.usage_row({
                "label": payload.get("percentageLabel") or "Usage",
                "percentage": payload["percentage"],
                "severity": self.payload_severity(payload),
            }))

        if payload.get("resetCredits") is not None:
            credits = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
            credits_label = Gtk.Label(label="Reset credits", xalign=0, hexpand=True)
            credits_label.add_css_class("credits-label")
            credits.append(credits_label)
            credits_value = Gtk.Label(label=format_number(payload["resetCredits"]), xalign=1)
            credits_value.add_css_class("credits-value")
            credits.append(credits_value)
            self.append(credits)

        detail = residual_detail(payload)
        if detail:
            detail_label = Gtk.Label(label=detail, xalign=0, wrap=True)
            detail_label.set_lines(3)
            detail_label.add_css_class("detail-label")
            if self.payload_severity(payload) == "error":
                detail_label.add_css_class("detail-error")
            self.append(detail_label)

        if payload.get("authenticationRequired") is True:
            button = Gtk.Button(label="Reconnect")
            button.add_css_class("reconnect-button")
            button.connect("clicked", lambda _button: self.reconnect(self.provider))
            self.append(button)

        self.append(Gtk.Box(vexpand=True))
        timestamp = updated_text(payload.get("updatedAt"))
        if timestamp:
            updated = Gtk.Label(label=f"Updated {timestamp}", xalign=0)
            updated.add_css_class("updated-label")
            self.append(updated)

    @staticmethod
    def payload_severity(payload):
        classes = payload.get("class")
        if isinstance(classes, str):
            classes = [classes]
        classes = classes or []
        return next((value for value in ("error", "critical", "warning", "stale") if value in classes), "normal")

    def usage_row(self, row):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
        heading = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        label = Gtk.Label(label=compact_label(str(row.get("label") or "Usage")), xalign=0, hexpand=True)
        label.set_ellipsize(3)
        label.add_css_class("usage-label")
        heading.append(label)
        value = Gtk.Label(label=f"{format_number(row.get('percentage', 0))}%", xalign=1)
        value.add_css_class("usage-value")
        heading.append(value)
        box.append(heading)
        box.append(self.progress(row.get("percentage", 0), row.get("severity") or "normal"))

        pacing = row.get("pacing")
        if isinstance(pacing, dict) and pacing.get("expectedPercentage") is not None:
            expected_heading = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
            expected_label = Gtk.Label(label="Expected", xalign=0, hexpand=True)
            expected_label.add_css_class("expected-label")
            expected_heading.append(expected_label)
            expected_value = Gtk.Label(label=f"{format_number(pacing['expectedPercentage'])}%", xalign=1)
            expected_value.add_css_class("expected-value")
            expected_heading.append(expected_value)
            box.append(expected_heading)
            box.append(self.progress(pacing["expectedPercentage"], "expected"))

        if row.get("resetText"):
            reset = Gtk.Label(label=f"Resets {row['resetText']}", xalign=0)
            reset.add_css_class("reset-label")
            box.append(reset)
        return box

    @staticmethod
    def progress(value, style):
        bar = Gtk.ProgressBar()
        bar.set_fraction(max(0, min(100, float(value))) / 100)
        bar.add_css_class("expected" if style == "expected" else f"severity-{style}")
        return bar


class DashboardWindow(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="ClaudexBar")
        self.app = app
        self.cards = {}
        self.refreshing = False
        self.set_default_size(620, 450)
        self.set_resizable(False)
        self.add_css_class("claudexbar-window")

        if Gtk4LayerShell is not None:
            self.set_decorated(False)
            Gtk4LayerShell.init_for_window(self)
            Gtk4LayerShell.set_namespace(self, "claudexbar-dashboard")
            Gtk4LayerShell.set_layer(self, Gtk4LayerShell.Layer.OVERLAY)
            Gtk4LayerShell.set_anchor(self, Gtk4LayerShell.Edge.TOP, True)
            Gtk4LayerShell.set_anchor(self, Gtk4LayerShell.Edge.RIGHT, True)
            Gtk4LayerShell.set_margin(self, Gtk4LayerShell.Edge.TOP, 10)
            Gtk4LayerShell.set_margin(self, Gtk4LayerShell.Edge.RIGHT, 10)
            Gtk4LayerShell.set_keyboard_mode(self, Gtk4LayerShell.KeyboardMode.ON_DEMAND)

        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        root.add_css_class("claudexbar-root")
        self.set_child(root)

        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        title = Gtk.Label(label="ClaudexBar", xalign=0, hexpand=True)
        title.add_css_class("app-title")
        header.append(title)
        self.refresh_button = Gtk.Button(icon_name="view-refresh-symbolic")
        self.refresh_button.set_tooltip_text("Refresh all providers")
        self.refresh_button.add_css_class("icon-button")
        self.refresh_button.connect("clicked", lambda _button: self.refresh())
        header.append(self.refresh_button)
        root.append(header)

        cards = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12, homogeneous=True)
        cards.set_vexpand(True)
        for provider in PROVIDERS:
            card = ProviderCard(provider, self.launch_reconnect)
            self.cards[provider] = card
            cards.append(card)
        root.append(cards)

        self.error_label = Gtk.Label(xalign=0, wrap=True)
        self.error_label.add_css_class("error-banner")
        self.error_label.set_visible(False)
        root.append(self.error_label)

        keys = Gtk.EventControllerKey()
        keys.connect("key-pressed", self.on_key_pressed)
        self.add_controller(keys)
        GLib.timeout_add_seconds(300, self.periodic_refresh)
        self.refresh()

    def on_key_pressed(self, _controller, keyval, _keycode, state):
        if keyval == 65307:
            self.close()
            return True
        if keyval in (ord("r"), ord("R")) and state & 4:
            self.refresh()
            return True
        return False

    def periodic_refresh(self):
        self.refresh()
        return GLib.SOURCE_CONTINUE

    def refresh(self):
        if self.refreshing:
            return
        self.refreshing = True
        self.refresh_button.set_sensitive(False)
        self.error_label.set_visible(False)
        threading.Thread(target=self.load_payload, daemon=True).start()

    def load_payload(self):
        bun = find_bun()
        engine = find_engine()
        if bun is None:
            GLib.idle_add(self.finish_error, "Bun was not found. Set CLAUDEXBAR_BUN or install Bun.")
            return
        if engine is None:
            GLib.idle_add(self.finish_error, "claudexbar.ts was not found beside the dashboard.")
            return
        try:
            result = subprocess.run(
                [bun, engine, "--all"],
                check=True,
                capture_output=True,
                text=True,
                timeout=45,
            )
            aggregate = json.loads(result.stdout)
            providers = aggregate.get("providers")
            if not isinstance(providers, list):
                raise ValueError("aggregate payload has no providers list")
            GLib.idle_add(self.finish_refresh, providers)
        except (OSError, subprocess.SubprocessError, ValueError, json.JSONDecodeError) as error:
            GLib.idle_add(self.finish_error, f"Refresh failed: {error}")

    def finish_refresh(self, providers):
        entries = {entry.get("provider"): entry for entry in providers if isinstance(entry, dict)}
        for provider, card in self.cards.items():
            card.render(entries.get(provider))
        self.refreshing = False
        self.refresh_button.set_sensitive(True)
        return GLib.SOURCE_REMOVE

    def finish_error(self, message):
        self.error_label.set_label(message)
        self.error_label.set_visible(True)
        self.refreshing = False
        self.refresh_button.set_sensitive(True)
        return GLib.SOURCE_REMOVE

    def launch_reconnect(self, provider):
        bun = find_bun()
        engine = find_engine()
        commands = {
            "claude": ["claude", "auth", "login"],
            "codex": ["codex", "login"],
            "grok": [bun, engine, "--login", "grok"] if bun and engine else None,
        }
        command = commands.get(provider)
        terminal = shutil.which("xdg-terminal-exec")
        if command is None or terminal is None:
            self.finish_error("Reconnect requires xdg-terminal-exec and the provider CLI.")
            return
        try:
            process = subprocess.Popen([terminal, *command], start_new_session=True)
            threading.Thread(target=self.refresh_after_process, args=(process,), daemon=True).start()
        except OSError as error:
            self.finish_error(f"Could not start reconnect: {error}")

    def refresh_after_process(self, process):
        process.wait()
        GLib.idle_add(self.refresh)


class DashboardApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="com.github.andresreibel.ClaudexBar.Linux")
        self.window = None

    def do_startup(self):
        Gtk.Application.do_startup(self)
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS.encode())
        Gtk.StyleContext.add_provider_for_display(
            self.get_default_display(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        )
        self.set_accels_for_action("app.quit", ["Escape"])
        quit_action = Gio.SimpleAction.new("quit", None)
        quit_action.connect("activate", lambda _action, _value: self.quit())
        self.add_action(quit_action)

    @staticmethod
    def get_default_display():
        from gi.repository import Gdk

        return Gdk.Display.get_default()

    def do_activate(self):
        if self.window is not None:
            self.window.close()
            self.quit()
            return
        self.window = DashboardWindow(self)
        self.window.connect("destroy", lambda _window: self.quit())
        self.window.present()


if __name__ == "__main__":
    raise SystemExit(DashboardApp().run(sys.argv))
