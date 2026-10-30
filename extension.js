// -*- coding: utf-8-unix -*-

import Clutter from "gi://Clutter";
import Cogl from "gi://Cogl";
import GdkPixbuf from "gi://GdkPixbuf";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Shell from "gi://Shell";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { accentFromPixels, panelColor } from "./color.js";

Gio._promisify(Gio.File.prototype, "load_contents_async");
Gio._promisify(Gio.File.prototype, "read_async");
Gio._promisify(GdkPixbuf.Pixbuf, "new_from_stream_at_scale_async", "new_from_stream_finish");
Gio._promisify(Shell.Screenshot.prototype, "pick_color");

// Changing the accent restyles the shell and every app, which stutters
// whatever is moving, so wait for this long without input first.
const ACCENT_IDLE_TIME = 2000;

// Blur my Shell's panel blur actors, see components/panel/panel_background.js.
const BLUR_GROUP_NAME = "bms-panel-backgroundgroup";
const BLUR_WIDGET_NAME = "bms-panel-blurred-widget";
const BLUR_MASK_NAME = "panel-color-matcher-gradient-mask";

// Fades an actor vertically, multiplying its premultiplied color by an
// alpha going from topAlpha at the top edge to bottomAlpha at the bottom.
const GradientMaskEffect = GObject.registerClass({
  GTypeName: "PanelColorMatcherGradientMaskEffect",
}, class GradientMaskEffect extends Shell.GLSLEffect {

  vfunc_build_pipeline() {
    this.add_glsl_snippet(
      Cogl.SnippetHook.FRAGMENT,
      "uniform float top_alpha;\nuniform float bottom_alpha;",
      "cogl_color_out *= mix(top_alpha, bottom_alpha, cogl_tex_coord_in[0].t);",
      false);
  }

  vfunc_paint(node, paintContext, flags) {
    // An offscreen effect reuses its last frame unless the actor itself
    // changed, but the blur behind follows the stage without that, e.g.
    // while swiping workspaces. Like Blur my Shell's own effects, redraw
    // the input on every paint so the mask never freezes the blur.
    super.vfunc_paint(node, paintContext, flags | Clutter.EffectPaintFlags.ACTOR_DIRTY);
  }

  setAlphas(top, bottom) {
    if (top === this._top && bottom === this._bottom) {
      return;
    }

    this._top = top;
    this._bottom = bottom;
    this.set_uniform_float(this.get_uniform_location("top_alpha"), 1, [top]);
    this.set_uniform_float(this.get_uniform_location("bottom_alpha"), 1, [bottom]);
    this.queue_repaint();
  }

});

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
    // so fade the background along with the overview transition, gestures
    // included. 0 is hidden, 1 the window picker, 2 the app grid.
    this._stateAdjustment = Main.overview._overview.controls._stateAdjustment;
    this._stateAdjustment.connectObject(
      "notify::value", () => this._syncBackground(),
      this);

    // The shell resets the panel's inline style when a gesture ends and
    // after the overview has hidden (_hideDone in overview.js), so put ours back.
    Main.panel.connectObject(
      "notify::style", () => {
        if (Main.panel.style !== this._style) {
          this._syncBackground();
        }
      },
      this);

    // Blur my Shell may create or recreate its panel blur at any time,
    // e.g. when enabled after us or when its settings change.
    Main.panel.get_parent().connectObject(
      "child-added", () => this._syncBackground(),
      this);

    Main.overview.connectObject(
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
      "changed", () => {
        this._updateDelayed(1500);
        this._updateAccent();
      },
      this);

    // Switching dark mode swaps in the picture-uri-dark wallpaper
    // without changing any background setting.
    this._interfaceSettings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" });
    this._interfaceSettings.connectObject(
      "changed::color-scheme", () => {
        this._updateDelayed(1500);
        this._updateAccent();
      },
      this);

    this._settings = this.getSettings();
    this._settings.connectObject(
      "changed::opacity", () => this._syncBackground(),
      "changed::maximized-opacity", () => this._syncBackground(),
      "changed::gradient", () => this._syncBackground(),
      "changed::gradient-opacity", () => this._syncBackground(),
      "changed::compensate-brightness", () => this._syncBackground(),
      "changed::text-contrast", () => this._syncBackground(),
      "changed::wallpaper-accent", () => this._updateAccent(),
      this);

    this._enabled = true;
    this._bg = null;
    this._style = null;
    this._maximized = false;
    this._updateTimeout = null;
    this._quickTimeout = null;
    this._accentRequest = 0;
    this._accentWatch = 0;
    this._update();
    this._updateAccent();
  }

  disable() {
    this._enabled = false;
    this._removeAccentWatch();

    // The lock screen disables extensions too. Keep the accent there to
    // spare every app two restyles per lock.
    if (Main.sessionMode.currentMode !== "unlock-dialog") {
      this._restoreAccent();
    }

    global.display.disconnectObject(this);
    global.window_manager.disconnectObject(this);
    Main.overview.disconnectObject(this);
    this._stateAdjustment.disconnectObject(this);
    this._stateAdjustment = null;
    Main.panel.disconnectObject(this);
    Main.panel.get_parent().disconnectObject(this);
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

    this._syncBlurMask(null);
    Main.panel.set_style(null);
    this._bg = null;
    this._style = null;
  }

  _debug(message) {
    if (this._settings.get_boolean("debug")) {
      console.log(`panel-color-matcher: ${message}`);
    }
  }

  _restoreAccent() {
    const saved = this._settings.get_string("saved-accent");

    if (saved) {
      this._interfaceSettings.set_string("accent-color", saved);
      this._settings.set_string("saved-accent", "");
    }
  }

  _removeAccentWatch() {
    if (this._accentWatch) {
      global.backend.get_core_idle_monitor().remove_watch(this._accentWatch);
      this._accentWatch = 0;
    }
  }

  _setAccentWhenIdle(accent) {
    const monitor = global.backend.get_core_idle_monitor();
    const apply = () => {
      this._removeAccentWatch();

      // Every app restyles on a change, so write only a different value.
      if (accent !== this._interfaceSettings.get_string("accent-color")) {
        this._interfaceSettings.set_string("accent-color", accent);
      }
    };

    this._removeAccentWatch();

    if (monitor.get_idletime() >= ACCENT_IDLE_TIME) {
      apply();

      return;
    }

    this._accentWatch = monitor.add_idle_watch(ACCENT_IDLE_TIME, apply);
  }

  async _updateAccent() {
    // A newer wallpaper or a turned-off switch replaces any pending accent.
    this._removeAccentWatch();

    if (!this._settings.get_boolean("wallpaper-accent")) {
      this._restoreAccent();

      return;
    }

    // Only the latest request may write, if wallpapers change quickly.
    const request = ++this._accentRequest;
    let key = "picture-uri";

    if (this._interfaceSettings.get_string("color-scheme") === "prefer-dark") {
      key = "picture-uri-dark";
    }

    const uri = this._backgroundSettings.get_string(key);
    let accent;

    try {
      let file = Gio.File.new_for_uri(uri);

      // shortcut: a slideshow XML uses its first image, even when the
      // shell shows a later one; track the slideshow clock if hues differ.
      if (uri.endsWith(".xml")) {
        const [contents] = await file.load_contents_async(null);
        const path = new TextDecoder().decode(contents).match(/<file>\s*([^<]+?)\s*<\/file>/)[1];
        file = Gio.File.new_for_path(path);
      }

      // Decode in a worker thread, scaled down while decoding, so even
      // a large wallpaper never blocks the shell.
      const stream = await file.read_async(GLib.PRIORITY_DEFAULT, null);
      const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, 64, 64, true, null);
      stream.close(null);
      accent = accentFromPixels(
        pixbuf.read_pixel_bytes().toArray(),
        pixbuf.width,
        pixbuf.height,
        pixbuf.n_channels,
        pixbuf.rowstride);
    } catch (e) {
      // Broken slideshows and unsupported formats keep the current accent.
      console.warn(`panel-color-matcher: no accent from ${uri}: ${e.message}`);

      return;
    }

    if (!this._enabled || request !== this._accentRequest) {
      return;
    }

    this._debug(`accent ${accent} from ${uri}`);
    const current = this._interfaceSettings.get_string("accent-color");

    // Save the user's own accent once; a saved value survives a crash.
    if (!this._settings.get_string("saved-accent")) {
      this._settings.set_string("saved-accent", current);
    }

    this._setAccentWhenIdle(accent);
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

  _blurActor() {
    // Blur my Shell inserts its panel blur behind the panel, in the panel
    // box, as a background group holding the blurred widget.
    const group = Main.panel.get_parent()?.get_children()
      .find(c => c.name === BLUR_GROUP_NAME);

    return group?.get_children().find(c => c.name === BLUR_WIDGET_NAME) ?? null;
  }

  _syncBlurMask(bottomOpacity) {
    // The blur is its own actor behind the panel, so the panel's gradient
    // can't make it transparent. Fade it with the same vertical gradient,
    // from full blur at the top to bottomOpacity, or drop the mask on null.
    const actor = this._blurActor();

    if (!actor) {
      return;
    }

    let effect = actor.get_effect(BLUR_MASK_NAME);

    if (bottomOpacity === null) {
      if (effect) {
        actor.remove_effect(effect);
      }

      return;
    }

    // Added after Blur my Shell's backdrop capture, so the capture still
    // reads the stage and only its result is drawn through the mask.
    if (!effect) {
      effect = new GradientMaskEffect();
      actor.add_effect_with_name(BLUR_MASK_NAME, effect);
    }

    effect.setAlphas(1, bottomOpacity);
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

  _syncBackground() {
    if (!this._bg) {
      this._style = null;
      Main.panel.set_style(null);
      this._syncBlurMask(null);

      return;
    }

    let key = "opacity";

    if (this._maximized) {
      key = "maximized-opacity";
    }

    const opacity = this._settings.get_int(key) / 100;
    const overview = Math.min(this._stateAdjustment.value, 1);
    // A window filling the screen under the panel gets a solid panel.
    const gradient = this._settings.get_boolean("gradient") && !this._maximized;
    let bottomOpacity = opacity;

    if (gradient) {
      bottomOpacity = this._settings.get_int("gradient-opacity") / 100;
    }

    // The text sits mid-height, where a gradient has the mean of its ends,
    // so judge brightness and contrast at that opacity.
    const [r, g, b] = panelColor(
      this._bg.split(",").map(Number),
      (opacity + bottomOpacity) / 2,
      this._settings.get_boolean("compensate-brightness"),
      this._settings.get_int("text-contrast") / 100);
    const top = `rgba(${r}, ${g}, ${b}, ${opacity * (1 - overview)})`;

    if (gradient) {
      // St draws gradients with alpha, so the transparent end shows what is
      // behind the panel. The start color doubles as background-color,
      // overriding the theme's.
      const bottom = `rgba(${r}, ${g}, ${b}, ${bottomOpacity * (1 - overview)})`;
      this._style = "background-gradient-direction: vertical; " +
        `background-gradient-start: ${top}; background-gradient-end: ${bottom};`;
      this._syncBlurMask(bottomOpacity);
    } else {
      this._style = `background-color: ${top};`;
      this._syncBlurMask(null);
    }

    // Follow the overview frame by frame instead of crossfading behind it.
    if (overview > 0) {
      this._style += " transition-duration: 0ms;";
    }

    Main.panel.set_style(this._style);
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
