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

import { accentFromPixels, darkTextColor, panelColor, prevalentColor, shadowColor } from "./color.js";

Gio._promisify(Gio.File.prototype, "load_contents_async");
Gio._promisify(Gio.File.prototype, "read_async");
Gio._promisify(GdkPixbuf.Pixbuf, "new_from_stream_at_scale_async", "new_from_stream_finish");
Gio._promisify(Shell.Screenshot.prototype, "screenshot_area");

// Changing the accent restyles the shell and every app, which stutters
// whatever is moving, so wait for this long without input first.
const ACCENT_IDLE_TIME = 2000;

// Backdrop samples taken along the panel's width, all from one capture.
const SAMPLE_COUNT = 16;

// Each sample repaints the stage once, so take at most one per this many
// ms; requests in between are coalesced into one at the end of it.
const SAMPLE_INTERVAL = 300;

// Blur my Shell's panel blur actors, see components/panel/panel_background.js.
const BLUR_GROUP_NAME = "bms-panel-backgroundgroup";
const BLUR_WIDGET_NAME = "bms-panel-blurred-widget";
const BLUR_MASK_NAME = "panel-color-matcher-gradient-mask";

// Panel style classes for dark text and icons and their shadows, see
// stylesheet.css.
const DARK_TEXT_CLASS = "panel-color-matcher-dark-text";
const TEXT_SHADOW_CLASS = "panel-color-matcher-text-shadow";
const SHADOW_EFFECT_NAME = "panel-color-matcher-shadow";

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

// Draws a soft shadow beneath everything an actor paints, cast from its
// alpha 2 px down with a Gaussian blur of about 12 px, in shadow_color
// (straight, not premultiplied). It samples a 9x9 grid 3 px apart, which
// the texture's linear filtering smooths between.
const ShadowEffect = GObject.registerClass({
  GTypeName: "PanelColorMatcherShadowEffect",
}, class ShadowEffect extends Shell.GLSLEffect {

  vfunc_build_pipeline() {
    this.add_glsl_snippet(
      Cogl.SnippetHook.FRAGMENT,
      "uniform vec4 shadow_color;\nuniform vec2 pixel_size;",
      `vec2 uv = cogl_tex_coord_in[0].st - vec2(0.0, 2.0) * pixel_size;
      float alpha = 0.0;
      float total = 0.0;

      for (int x = -4; x <= 4; x++) {
        for (int y = -4; y <= 4; y++) {
          float w = exp(-float(x * x + y * y) / 8.0);
          alpha += w * texture2D(cogl_sampler0, uv + vec2(float(x), float(y)) * 3.0 * pixel_size).a;
          total += w;
        }
      }

      vec4 shadow = vec4(shadow_color.rgb, 1.0) * shadow_color.a * (alpha / total) * cogl_color_in.a;
      cogl_color_out += shadow * (1.0 - cogl_color_out.a);`,
      false);
  }

  vfunc_paint(node, paintContext, flags) {
    // The texture spans the actor, so a pixel is 1 / its size.
    const [width, height] = this.actor.get_size();

    if (width !== this._width || height !== this._height) {
      this._width = width;
      this._height = height;
      this.set_uniform_float(this.get_uniform_location("pixel_size"), 2, [1 / width, 1 / height]);
    }

    super.vfunc_paint(node, paintContext, flags);
  }

  setColor(color) {
    // color is [r, g, b] in 0-255 and alpha in 0-1.
    if (color.join() === this._color?.join()) {
      return;
    }

    this._color = color;
    const [r, g, b, alpha] = color;
    this.set_uniform_float(this.get_uniform_location("shadow_color"), 4, [r / 255, g / 255, b / 255, alpha]);
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

    // A new monitor layout moves the panel, or gives a monitorless session
    // its first monitor to sample.
    Main.layoutManager.connectObject(
      "monitors-changed", () => this._updateDelayed(),
      this);

    // An inline style overrides the theme's transparent #panel:overview,
    // so drop ours while the overview shows and let the theme's transition
    // crossfade the panel. Following the overview frame by frame would
    // restyle the whole panel on every frame, which stutters gestures.
    this._overviewShowing = Main.overview.visible;

    // The shell resets the panel's inline style when a gesture ends and
    // after the overview has hidden (_hideDone in overview.js), so put ours
    // back. While the overview shows, the shell owns the style.
    Main.panel.connectObject(
      "notify::style", () => {
        if (!this._overviewShowing && Main.panel.style !== this._style) {
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
      "changed::brightness-compensation", () => this._syncBackground(),
      "changed::text-contrast", () => this._syncBackground(),
      "changed::invert-text", () => this._syncBackground(),
      "changed::text-shadow", () => {
        this._syncTextShadow();
        this._syncBackground();
      },
      "changed::wallpaper-accent", () => this._updateAccent(),
      this);

    this._enabled = true;
    this._bg = null;
    this._style = null;
    this._maximized = false;
    this._updateTimeout = null;
    this._quickTimeout = null;
    this._throttleTimeout = null;
    this._sampling = false;
    this._lastSample = -Infinity;
    this._accentRequest = 0;
    this._accentWatch = 0;
    this._syncTextShadow();
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
    Main.layoutManager.disconnectObject(this);
    Main.overview.disconnectObject(this);
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

    if (this._throttleTimeout) {
      GLib.source_remove(this._throttleTimeout);
      this._throttleTimeout = null;
    }

    if (this._quickTimeout) {
      GLib.source_remove(this._quickTimeout);
      this._quickTimeout = null;
    }

    this._syncBlurMask(null);
    this._syncDarkText(false);
    this._syncShadowEffect(null);
    Main.panel.remove_style_class_name(TEXT_SHADOW_CLASS);
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

  async _sampleStrip(x, y, width) {
    // Every capture repaints the stage synchronously, which stalls
    // whatever is animating, so capture one 1 px high strip, not one pixel
    // per sample. Its PNG is encoded in a worker thread and tiny.
    const screenshot = new Shell.Screenshot();
    const stream = Gio.MemoryOutputStream.new_resizable();
    await screenshot.screenshot_area(x, y, width, 1, stream);
    stream.close(null);
    const png = Gio.MemoryInputStream.new_from_bytes(stream.steal_as_bytes());
    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(png, null);
    // On a scaled monitor the strip has more pixels than logical width.
    const pixels = pixbuf.read_pixel_bytes().toArray();
    const channels = pixbuf.n_channels;

    return Array.from({ length: SAMPLE_COUNT }, (_, i) => {
      const p = Math.floor(pixbuf.width * (i + 0.5) / SAMPLE_COUNT) * channels;

      return { r: pixels[p], g: pixels[p + 1], b: pixels[p + 2] };
    });
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

  _syncDarkText(dark) {
    // stylesheet.css recolors the text and symbolic icons under this class.
    if (dark) {
      Main.panel.add_style_class_name(DARK_TEXT_CLASS);
    } else {
      Main.panel.remove_style_class_name(DARK_TEXT_CLASS);
    }
  }

  _syncTextShadow() {
    // stylesheet.css drops the per-label and per-icon shadows, since the
    // shadow effect on the panel's sections takes their place.
    if (this._settings.get_boolean("text-shadow")) {
      Main.panel.add_style_class_name(TEXT_SHADOW_CLASS);
    } else {
      Main.panel.remove_style_class_name(TEXT_SHADOW_CLASS);
    }
  }

  _syncShadowEffect(color) {
    // Shadow everything each section draws, whatever kind of actor, from
    // a tinted [r, g, b, alpha] color, or remove the shadow on null. The
    // panel background sits on the panel itself, so it casts none.
    for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]) {
      let effect = box.get_effect(SHADOW_EFFECT_NAME);

      if (color === null) {
        if (effect) {
          box.remove_effect(effect);
        }

        continue;
      }

      if (!effect) {
        effect = new ShadowEffect();
        box.add_effect_with_name(SHADOW_EFFECT_NAME, effect);
      }

      effect.setColor(color);
    }
  }

  _setOverviewShowing(showing) {
    this._overviewShowing = showing;
    this._syncBackground();
  }

  _syncBackground() {
    if (!this._bg) {
      this._style = null;
      Main.panel.set_style(null);
      this._syncBlurMask(null);
      this._syncDarkText(false);
      this._syncShadowEffect(null);

      return;
    }

    // The overview shows the panel transparent over its own dark backdrop,
    // so leave the panel to the theme until it hides again.
    if (this._overviewShowing) {
      this._style = null;
      Main.panel.set_style(null);
      this._syncDarkText(false);
      this._syncShadowEffect(null);

      return;
    }

    let key = "opacity";

    if (this._maximized) {
      key = "maximized-opacity";
    }

    const opacity = this._settings.get_int(key) / 100;
    // A window filling the screen under the panel gets a solid panel.
    const gradient = this._settings.get_boolean("gradient") && !this._maximized;
    let bottomOpacity = opacity;

    if (gradient) {
      bottomOpacity = this._settings.get_int("gradient-opacity") / 100;
    }

    // The text sits mid-height, where a gradient has the mean of its ends,
    // so judge brightness and contrast at that opacity.
    const { rgb: [r, g, b], darkText, contrast } = panelColor(
      this._bg.split(",").map(Number),
      (opacity + bottomOpacity) / 2,
      this._settings.get_int("brightness-compensation") / 100,
      this._settings.get_int("text-contrast") / 100,
      this._settings.get_boolean("invert-text"),
      gradient);
    this._syncDarkText(darkText);
    const top = `rgba(${r}, ${g}, ${b}, ${opacity})`;

    if (gradient) {
      // St draws gradients with alpha, so the transparent end shows what is
      // behind the panel. The start color doubles as background-color,
      // overriding the theme's.
      const bottom = `rgba(${r}, ${g}, ${b}, ${bottomOpacity})`;
      this._style = "background-gradient-direction: vertical; " +
        `background-gradient-start: ${top}; background-gradient-end: ${bottom};`;
      this._syncBlurMask(bottomOpacity);
    } else {
      this._style = `background-color: ${top};`;
      this._syncBlurMask(null);
    }

    // Each section of the panel casts one shadow from all it draws.
    if (this._settings.get_boolean("text-shadow")) {
      this._syncShadowEffect(shadowColor([r, g, b], darkText, contrast));
    } else {
      this._syncShadowEffect(null);
    }

    // stylesheet.css makes the dark text and icons take this color.
    if (darkText) {
      this._style += ` color: rgb(${darkTextColor([r, g, b]).join(", ")});`;
    }

    Main.panel.set_style(this._style);
  }

  _update(quick = false) {
    if (Main.overview.visible) {
      return;
    }

    // Without a monitor, e.g. early in a nested or headless session, the
    // shell's screenshot reads a 0x0 area and crashes the shell.
    // monitors-changed samples again once one appears. The primary index
    // is 0 even then, so count the monitors.
    if (global.display.get_n_monitors() === 0) {
      return;
    }

    // Throttle: while a sample is queued, ignore requests. Within
    // SAMPLE_INTERVAL of the last one, or while one is in flight, queue a
    // single settled one for later, as it covers whatever asked meanwhile.
    if (this._throttleTimeout) {
      return;
    }

    let wait = this._lastSample + SAMPLE_INTERVAL - GLib.get_monotonic_time() / 1000;

    if (this._sampling) {
      wait = Math.max(wait, SAMPLE_INTERVAL);
    }

    if (wait > 0) {
      this._throttleTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait), () => {
        this._throttleTimeout = null;
        this._update();

        return GLib.SOURCE_REMOVE;
      });

      return;
    }

    this._lastSample = GLib.get_monotonic_time() / 1000;
    this._sampling = true;
    const index = global.display.get_primary_monitor();
    const monitor = global.display.get_monitor_geometry(index);
    // Sample along the whole width, so the most common color wins over a
    // spot of a busy wallpaper, and a half-maximized window shows as half
    // of the samples.
    const y = monitor.y + Main.panel.height + 3;

    this._sampleStrip(monitor.x, y, monitor.width).then(colors => {
      this._sampling = false;

      if (!this._enabled) {
        return;
      }

      this._debug(`sampled ${JSON.stringify(colors)} ` +
        `overview.visible=${Main.overview.visible} animationInProgress=${Main.overview.animationInProgress}`);
      // Don't adopt the overview's backdrop as the panel color.
      if (Main.overview.visible) {
        return;
      }

      const bg = prevalentColor(colors.map(c => [c.r, c.g, c.b])).join(", ");
      const maximized = this._hasMaximizedWindow();
      // Maximize state flips before the window animation ends, so a quick
      // sample would change opacity ahead of the color. Leave that to the
      // settled sample so both crossfade in one transition.
      if (quick && maximized !== this._maximized) {
        return;
      }

      this._applyStyle(bg, maximized);
    }).catch(e => {
      this._sampling = false;
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
