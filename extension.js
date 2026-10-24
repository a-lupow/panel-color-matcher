// -*- coding: utf-8-unix -*-

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Shell from "gi://Shell";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { panelColor } from "./color.js";

Gio._promisify(Shell.Screenshot.prototype, "pick_color");

export default class PanelColorMatcher extends Extension {

  enable() {
    // https://mutter.gnome.org/meta/class.Display.html#signals
    global.display.connectObject(
      "focus-window", () => this._updateDelayed(),
      this);

    // https://github.com/GNOME/gnome-shell/blob/main/js/ui/windowManager.js
    global.window_manager.connectObject(
      "destroy", () => this._updateDelayed(),
      "minimize", () => this._updateDelayed(),
      "size-changed", () => this._updateDelayed(),
      "switch-workspace", () => this._updateDelayed(),
      "unminimize", () => this._updateDelayed(),
      this);

    // An inline style overrides the theme's transparent #panel:overview,
    // so drop the background while the overview is shown.
    Main.overview.connectObject(
      "showing", () => this._setOverviewShowing(true),
      "hiding", () => this._setOverviewShowing(false),
      // Samples taken while the overview was visible captured its
      // backdrop, so resample once the desktop is back on screen.
      "hidden", () => {
        this._debug("overview hidden");
        this._updateDelayed();
      },
      this);

    // The shell crossfades to a new wallpaper over about a second
    // (FADE_ANIMATION_TIME in background.js), so wait for it to finish.
    this._backgroundSettings = new Gio.Settings({ schema_id: "org.gnome.desktop.background" });
    this._backgroundSettings.connectObject(
      "changed", () => this._updateDelayed(1500),
      this);

    // Switching dark mode swaps in the picture-uri-dark wallpaper
    // without changing any background setting.
    this._interfaceSettings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" });
    this._interfaceSettings.connectObject(
      "changed::color-scheme", () => this._updateDelayed(1500),
      this);

    this._settings = this.getSettings();
    this._settings.connectObject(
      "changed::opacity", () => this._syncBackground(),
      "changed::maximized-opacity", () => this._syncBackground(),
      "changed::compensate-brightness", () => this._syncBackground(),
      "changed::text-contrast", () => this._syncBackground(),
      this);

    this._enabled = true;
    this._bg = null;
    this._maximized = false;
    this._overviewShowing = Main.overview.visible;
    this._updateTimeout = null;
    this._quickTimeout = null;
    this._update();
  }

  disable() {
    this._enabled = false;
    global.display.disconnectObject(this);
    global.window_manager.disconnectObject(this);
    Main.overview.disconnectObject(this);
    this._backgroundSettings.disconnectObject(this);
    this._backgroundSettings = null;
    this._interfaceSettings.disconnectObject(this);
    this._interfaceSettings = null;
    this._settings.disconnectObject(this);
    this._settings = null;

    if (this._updateTimeout) {
      GLib.source_remove(this._updateTimeout);
      this._updateTimeout = null;
    }

    if (this._quickTimeout) {
      GLib.source_remove(this._quickTimeout);
      this._quickTimeout = null;
    }

    Main.panel.set_style(null);
    this._bg = null;
  }

  _debug(message) {
    if (this._settings.get_boolean("debug")) {
      console.log(`panel-color-matcher: ${message}`);
    }
  }

  async _sampleColor(x, y) {
    // Read a single pixel like the shell's color picker does, instead of
    // capturing and encoding the whole stage.
    const screenshot = new Shell.Screenshot();
    const [color] = await screenshot.pick_color(x, y);

    return { r: color.red, g: color.green, b: color.blue };
  }

  _applyStyle(bg, maximized) {
    // Restyle only the panel subtree instead of reloading the theme,
    // which would restyle the whole stage. The theme's transition-duration
    // on #panel and .panel-button makes St crossfade the change.
    if (bg === this._bg && maximized === this._maximized) {
      return;
    }

    this._bg = bg;
    this._maximized = maximized;
    this._syncBackground();
  }

  _hasMaximizedWindow() {
    // Whether a maximized or fullscreen window sits under the panel,
    // i.e. on the primary monitor of the active workspace.
    const workspace = global.workspace_manager.get_active_workspace();
    const primary = global.display.get_primary_monitor();

    return workspace.list_windows().some(w =>
      w.get_monitor() === primary &&
      w.showing_on_its_workspace() &&
      (w.is_maximized() || w.is_fullscreen()));
  }

  _setOverviewShowing(showing) {
    this._overviewShowing = showing;
    this._syncBackground();
  }

  _syncBackground() {
    if (!this._bg || this._overviewShowing) {
      Main.panel.set_style(null);

      return;
    }

    let key = "opacity";

    if (this._maximized) {
      key = "maximized-opacity";
    }

    const opacity = this._settings.get_int(key) / 100;
    const [r, g, b] = panelColor(
      this._bg.split(",").map(Number),
      opacity,
      this._settings.get_boolean("compensate-brightness"),
      this._settings.get_int("text-contrast") / 100);
    Main.panel.set_style(`background-color: rgba(${r}, ${g}, ${b}, ${opacity});`);
  }

  _update(quick = false) {
    if (Main.overview.visible) {
      return;
    }

    const index = global.display.get_primary_monitor();
    const monitor = global.display.get_monitor_geometry(index);
    // Sample at 25% and 75% to detect half-maximized windows.
    const x1 = monitor.x + Math.floor(monitor.width * 0.25);
    const x2 = monitor.x + Math.floor(monitor.width * 0.75);
    const y = monitor.y + Main.panel.height + 3;

    Promise.all([
      this._sampleColor(x1, y),
      this._sampleColor(x2, y),
    ]).then(([color1, color2]) => {
      if (!this._enabled) {
        return;
      }

      this._debug(`sampled ${JSON.stringify([color1, color2])} ` +
        `overview.visible=${Main.overview.visible} animationInProgress=${Main.overview.animationInProgress}`);
      // Don't adopt the overview's backdrop as the panel color.
      if (Main.overview.visible) {
        return;
      }

      // In case one window is half-maximized either on the left or the
      // right side, find the side where the color is lightest or darkest,
      // since windows tend to be either light or dark and wallpapers
      // between. Also, note the chosen midpoint, which controls what
      // happens when one light window and one dark window are
      // half-maximized. Raising that value above 128 favors dark.
      const distance = c => Math.abs(c.r - 155) + Math.abs(c.g - 155) + Math.abs(c.b - 155);
      let color = color2;

      if (distance(color1) > distance(color2)) {
        color = color1;
      }


      const bg = `${color.r}, ${color.g}, ${color.b}`;
      const maximized = this._hasMaximizedWindow();
      // Maximize state flips before the window animation ends, so a quick
      // sample would change opacity ahead of the color. Leave that to the
      // settled sample so both crossfade in one transition.
      if (quick && maximized !== this._maximized) {
        return;
      }

      this._applyStyle(bg, maximized);
    }).catch(e => {
      console.error("Color sampling failed:", e);
    });
  }

  _updateDelayed(delay = 400) {
    // Sample quickly for a responsive first guess, then again once
    // window animations (about 250 ms) or the wallpaper crossfade have
    // settled. The quick sample isn't postponed by a burst of events.
    // A long delay means a wallpaper crossfade, where a quick sample
    // would catch a half-faded color.
    if (delay <= 400) {
      this._quickTimeout ??= GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        this._update(true);
        this._quickTimeout = null;

        return GLib.SOURCE_REMOVE;
      });
    }

    if (this._updateTimeout) {
      GLib.source_remove(this._updateTimeout);
    }

    this._updateTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      this._update();
      this._updateTimeout = null;

      return GLib.SOURCE_REMOVE;
    });
  }

}
