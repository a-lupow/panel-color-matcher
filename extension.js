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

import {
  R, accentFromPixels, blendStrength, darkTextColor, panelColor, prevalentColor, samplesUnder, shadowFactors,
} from "./color.js";

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
// It also deepens each pixel from its own color, at strength at the top
// edge fading to none at the bottom, as deepenPixel() in color.js does, so
// every part of the backdrop deepens in its own hue.
const GradientMaskEffect = GObject.registerClass({
  GTypeName: "PanelColorMatcherGradientMaskEffect",
}, class GradientMaskEffect extends Shell.GLSLEffect {

  vfunc_build_pipeline() {
    this.add_glsl_snippet(
      Cogl.SnippetHook.FRAGMENT,
      "uniform float top_alpha;\nuniform float bottom_alpha;\nuniform float strength;\n" +
      "uniform float dark_weight;\nuniform float mul;\nuniform float weight_min;\nuniform float weight_max;",
      `float t = cogl_tex_coord_in[0].t;
      float a = max(cogl_color_out.a, 0.0001);
      vec3 c = cogl_color_out.rgb / a;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      float amount = strength * (1.0 - t) * mix(dark_weight, 1.0, l);
      vec3 weight = clamp(mul + (1.0 - mul) * (1.0 - c) / max(1.0 - l, 0.05), weight_min, weight_max);
      c *= max(vec3(1.0 / 3.0), 1.0 - amount * weight);
      cogl_color_out.rgb = c * a;
      cogl_color_out *= mix(top_alpha, bottom_alpha, t);`,
      false);
  }

  vfunc_paint(node, paintContext, flags) {
    // An offscreen effect reuses its last frame unless the actor itself
    // changed, but the blur behind follows the stage without that, e.g.
    // while swiping workspaces. Like Blur my Shell's own effects, redraw
    // the input on every paint so the mask never freezes the blur.
    super.vfunc_paint(node, paintContext, flags | Clutter.EffectPaintFlags.ACTOR_DIRTY);
  }

  setAlphas(top, bottom, strength) {
    if (top === this._top && bottom === this._bottom && strength === this._strength) {
      return;
    }

    this._top = top;
    this._bottom = bottom;
    this._strength = strength;
    this.set_uniform_float(this.get_uniform_location("top_alpha"), 1, [top]);
    this.set_uniform_float(this.get_uniform_location("bottom_alpha"), 1, [bottom]);
    this.set_uniform_float(this.get_uniform_location("strength"), 1, [strength]);
    this.set_uniform_float(this.get_uniform_location("dark_weight"), 1, [R.darkWeight]);
    this.set_uniform_float(this.get_uniform_location("mul"), 1, [R.mul]);
    this.set_uniform_float(this.get_uniform_location("weight_min"), 1, [R.weightMin]);
    this.set_uniform_float(this.get_uniform_location("weight_max"), 1, [R.weightMax]);
    this.queue_repaint();
  }

});

// Multiplies the stage beneath everything an actor paints by factor, a
// [r, g, b] in 0-1, as a soft shadow cast from the actor's alpha offset px
// down. The shadow falls off with the distance to the nearest drawn pixel,
// as a Gaussian with a sigma of 3 x spread px, fading out at 6 x spread
// px, so a thin text stroke casts the same shadow as a solid icon.
// Averaging the alpha around each pixel instead, as a plain blur does,
// gives solid shapes a much denser shadow than thin text, and builds lines
// of text up into a dark band. It takes the strongest weighted tap of a
// disc of taps spread px apart, 6 taps in radius, whose weight drops to
// exactly 0 at its edge: a square grid cut off at a weight of 0.14 gave
// every halo square corners and a hard rim.
//
// Thin strokes falling between taps leave stripes spread px apart in the
// halo, so the result is blurred by averaging it at four points in a
// rotated grid, whose offsets along either axis are a quarter of spread
// apart, which cancels them out. Wider radii space the taps further than
// the strokes are thick, so taps read the alpha prefiltered over spread / 2
// px from the mipmap level lod, as at a radius of 12 on a 1x monitor.
const SHADOW_SNIPPET = [
  `uniform float factor_r;
  uniform float factor_g;
  uniform float factor_b;
  uniform float pixel_w;
  uniform float pixel_h;
  uniform float spread;
  uniform float offset;
  uniform float opacity;
  uniform float lod;

  float shadow_coverage(sampler2D sampler, vec2 uv, vec2 step, float lod) {
    float coverage = 0.0;

    for (int x = -6; x <= 6; x++) {
      for (int y = -6; y <= 6; y++) {
        float r2 = float(x * x + y * y);

        if (r2 < 36.0) {
          float w = (exp(-r2 / 18.0) - exp(-2.0)) / (1.0 - exp(-2.0));
          coverage = max(coverage, w * texture2D(sampler, uv + vec2(float(x), float(y)) * step, lod).a);
        }
      }
    }

    return coverage;
  }`,
  `vec2 pixel_size = vec2(pixel_w, pixel_h);
  vec2 uv = cogl_tex_coord_in[0].st - vec2(0.0, offset) * pixel_size;
  vec2 step = spread * pixel_size;
  vec2 j = 0.125 * step;
  float coverage = 0.25 * (
    shadow_coverage(cogl_sampler0, uv + vec2(-3.0, -1.0) * j, step, lod) +
    shadow_coverage(cogl_sampler0, uv + vec2(1.0, -3.0) * j, step, lod) +
    shadow_coverage(cogl_sampler0, uv + vec2(3.0, 1.0) * j, step, lod) +
    shadow_coverage(cogl_sampler0, uv + vec2(-1.0, 3.0) * j, step, lod));

  coverage *= opacity;
  cogl_color_out = vec4(mix(vec3(1.0), vec3(factor_r, factor_g, factor_b), coverage), 1.0);`,
];

// The shadow pass keeps the stage's alpha and multiplies its color. Cogl's
// parser rejects an explicit "*(1)" factor, so the 1 is left implicit.
const SHADOW_BLEND = "RGB = ADD(SRC_COLOR*(DST_COLOR), 0) A = ADD(0, DST_COLOR)";

// Cogl reuses a compiled shader program only for pipelines sharing the same
// snippet object, not just the same source, so every new snippet compiles
// another one. Effects come and go with the overview, the lock screen and
// panel changes, so build the shadow pipeline once per session and give
// each effect a copy, or programs pile up until Cogl warns of over 50.
let shadowTemplate = null;

function shadowPipeline() {
  if (!shadowTemplate) {
    const context = Clutter.get_default_backend().get_cogl_context();
    const pipeline = Cogl.Pipeline.new(context);
    pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, ...SHADOW_SNIPPET));
    pipeline.set_blend(SHADOW_BLEND);
    // Cogl regenerates the mipmaps whenever the section is redrawn.
    pipeline.set_layer_filters(
      0, Cogl.PipelineFilter.LINEAR_MIPMAP_LINEAR, Cogl.PipelineFilter.LINEAR);
    shadowTemplate = pipeline;
  }

  return shadowTemplate.copy();
}

// Draws an actor with a dark shadow beneath it, see shadowFactors() in
// color.js, as a pass of its own that multiplies the stage, before the
// actor is drawn as is.
const ShadowEffect = GObject.registerClass({
  GTypeName: "PanelColorMatcherShadowEffect",
}, class ShadowEffect extends Shell.GLSLEffect {

  vfunc_build_pipeline() {
    // The actor itself is drawn unchanged.
  }

  vfunc_paint_target(node, paintContext) {
    if (this._factors) {
      this._paintShadow(node);
    }

    super.vfunc_paint_target(node, paintContext);
  }

  _paintShadow(node) {
    const texture = this.get_texture();

    if (!texture) {
      return;
    }

    if (!this._pipeline) {
      // Keep the pipeline only once it's set up, as drawing one without
      // the multiply blend covers the section in white. A shadow that
      // fails stays off rather than retrying on every frame.
      if (this._failed) {
        return;
      }

      try {
        this._pipeline = shadowPipeline();
      } catch (e) {
        this._failed = true;
        console.error("panel-color-matcher: no text shadow:", e);

        return;
      }
    }

    const pipeline = this._pipeline;
    // The texture spans the actor, so a pixel is 1 / its size. The panel
    // repaints with whatever moves beneath it, so set uniforms only when
    // they change.
    const [width, height] = this.actor.get_size();
    // The texture has more pixels than the actor on a scaled monitor.
    const lod = Math.max(0, Math.log2(this._radius / 12 * texture.get_width() / width));
    const values = {
      pixel_w: 1 / width,
      pixel_h: 1 / height,
      spread: this._radius / 6,
      lod,
      offset: this._distance,
      opacity: this.actor.get_paint_opacity() / 255,
      factor_r: this._factors[0],
      factor_g: this._factors[1],
      factor_b: this._factors[2],
    };
    this._uniforms ??= {};

    for (const [name, value] of Object.entries(values)) {
      if (this._uniforms[name] !== value) {
        this._uniforms[name] = value;
        pipeline.set_uniform_1f(pipeline.get_uniform_location(name), value);
      }
    }

    pipeline.set_layer_texture(0, texture);
    const shadowNode = Clutter.PipelineNode.new(pipeline);
    node.add_child(shadowNode);
    shadowNode.add_rectangle(Clutter.ActorBox.new(0, 0, texture.get_width(), texture.get_height()));
  }

  setShadow(factors, distance, radius) {
    // factors is [r, g, b] in 0-1, or null for no shadow; distance is how
    // far down the shadow is cast and radius how far out it fades, in px.
    if (factors?.join() === this._factors?.join() && distance === this._distance && radius === this._radius) {
      return;
    }

    this._factors = factors;
    this._distance = distance;
    this._radius = radius;
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
      "changed::text-shadow", () => this._syncBackground(),
      "changed::maximized-shadow", () => this._syncBackground(),
      "changed::shadow-distance", () => this._syncBackground(),
      "changed::shadow-radius", () => this._syncBackground(),
      "changed::shadow-opacity", () => this._syncBackground(),
      "changed::shadow-vibrance", () => this._syncBackground(),
      "changed::wallpaper-accent", () => this._updateAccent(),
      this);

    this._enabled = true;
    this._bg = null;
    this._samples = null;
    this._samplesKey = null;
    this._style = null;
    this._panelRedirect = null;
    this._maximized = false;
    this._updateTimeout = null;
    this._quickTimeout = null;
    this._throttleTimeout = null;
    this._sampling = false;
    this._lastSample = -Infinity;
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
    this._samples = null;
    this._samplesKey = null;
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

  _applyStyle(bg, maximized, samples) {
    // Restyle only the panel subtree instead of reloading the theme,
    // which would restyle the whole stage. The theme's transition-duration
    // on #panel and .panel-button makes St crossfade the change.
    const samplesKey = samples.join(";");

    if (bg === this._bg && maximized === this._maximized && samplesKey === this._samplesKey) {
      return;
    }

    this._bg = bg;
    this._maximized = maximized;
    this._samples = samples;
    this._samplesKey = samplesKey;
    this._syncBackground();
  }

  _blurActor() {
    // Blur my Shell inserts its panel blur behind the panel, in the panel
    // box, as a background group holding the blurred widget.
    const group = Main.panel.get_parent()?.get_children()
      .find(c => c.name === BLUR_GROUP_NAME);

    return group?.get_children().find(c => c.name === BLUR_WIDGET_NAME) ?? null;
  }

  _syncBlurMask(bottomOpacity, strength = 0) {
    // The blur is its own actor behind the panel, so the panel's gradient
    // can't make it transparent. Fade it with the same vertical gradient,
    // from full blur at the top to bottomOpacity, deepened at strength at
    // the top, or drop the mask on null.
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

    effect.setAlphas(1, bottomOpacity, strength);
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

  _shadowEnabled() {
    // Whether the text shadow is on, which a maximized or fullscreen window
    // under the panel may turn off.
    if (!this._settings.get_boolean("text-shadow")) {
      return false;
    }

    return !this._maximized || this._settings.get_boolean("maximized-shadow");
  }

  _syncTextShadow(enabled) {
    // stylesheet.css drops the per-label and per-icon shadows, since the
    // shadow effect on the panel's sections takes their place. Without
    // ours, the theme's own come back, as with the shadow switched off.
    if (enabled) {
      Main.panel.add_style_class_name(TEXT_SHADOW_CLASS);
    } else {
      Main.panel.remove_style_class_name(TEXT_SHADOW_CLASS);
    }
  }

  _sectionBoxes() {
    return [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
  }

  _syncShadowEffect(shadows) {
    // Shadow everything each section draws, whatever kind of actor, from
    // its [r, g, b] factors, one per section in the order of
    // _sectionBoxes(), a null one for none, or remove the shadows on null.
    // The panel background sits on the panel itself, so it casts none.
    //
    // The shell always draws the panel offscreen first (panel.js), where
    // the shadow's multiply would see only the panel's own, mostly
    // transparent background, not the wallpaper. So while shadows are on,
    // draw the panel straight onto the stage, offscreen only for opacity,
    // and give the shell its own setting back after.
    if (shadows === null || shadows.every(s => s === null)) {
      if (this._panelRedirect !== null) {
        Main.panel.set_offscreen_redirect(this._panelRedirect);
        this._panelRedirect = null;
      }
    } else if (this._panelRedirect === null) {
      this._panelRedirect = Main.panel.get_offscreen_redirect();
      Main.panel.set_offscreen_redirect(Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY);
    }

    for (const [i, box] of this._sectionBoxes().entries()) {
      let effect = box.get_effect(SHADOW_EFFECT_NAME);

      if (shadows === null) {
        if (effect) {
          box.remove_effect(effect);
        }

        continue;
      }

      if (!effect) {
        effect = new ShadowEffect();
        box.add_effect_with_name(SHADOW_EFFECT_NAME, effect);
      }

      effect.setShadow(
        shadows[i], this._settings.get_int("shadow-distance"), this._settings.get_int("shadow-radius"));
    }
  }

  _sectionShadows(panel, opacity, compensate, strength, gradient) {
    // Behind a gradient each section shows its own part of the backdrop,
    // e.g. the clock a blue sky while the left a dark rock decides the
    // panel color, so judge each one's contrast and tone from the samples
    // beneath it. The text color is one for the whole panel, so keep white text's
    // shadows even where the backdrop alone would get dark text. A solid
    // panel shows its one color everywhere, so it's that behind every
    // section. A dark shadow would cost dark text contrast, so it gets none.
    const boxes = this._sectionBoxes();
    const shadowOpacity = this._settings.get_int("shadow-opacity") / 100;
    const vibrance = this._settings.get_int("shadow-vibrance") / 100;

    if (panel.darkText) {
      return boxes.map(() => null);
    }

    if (!gradient || !this._samples) {
      return boxes.map(() => shadowFactors(panel.rgb, panel.contrast, shadowOpacity, vibrance));
    }

    const monitor = global.display.get_monitor_geometry(global.display.get_primary_monitor());

    return boxes.map(box => {
      const [x] = box.get_transformed_position();
      const x0 = x - monitor.x;
      const local = panelColor(
        prevalentColor(samplesUnder(this._samples, x0, x0 + box.width, monitor.width)),
        opacity, compensate, strength, false, gradient);

      return shadowFactors(local.rgb, local.contrast, shadowOpacity, vibrance);
    });
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
    const bg = this._bg.split(",").map(Number);
    const meanOpacity = (opacity + bottomOpacity) / 2;
    const compensate = this._settings.get_int("brightness-compensation") / 100;
    const strength = this._settings.get_int("text-contrast") / 100;
    const panel = panelColor(
      bg, meanOpacity, compensate, strength, this._settings.get_boolean("invert-text"), gradient);
    const { rgb: [r, g, b], darkText } = panel;
    this._syncDarkText(darkText);

    if (gradient) {
      // The blur deepens each part of the backdrop in its own color, so
      // the one flat panel color over it, which can't follow a backdrop of
      // several, only tints at R.tint of the opacity. Without the blur, the
      // panel color does all the work at the full opacity.
      let tint = 1;

      if (this._blurActor()) {
        tint = R.tint;
      }

      // St draws gradients with alpha, so the transparent end shows what is
      // behind the panel. The start color doubles as background-color,
      // overriding the theme's.
      const top = `rgba(${r}, ${g}, ${b}, ${opacity * tint})`;
      const bottom = `rgba(${r}, ${g}, ${b}, ${bottomOpacity * tint})`;
      this._style = "background-gradient-direction: vertical; " +
        `background-gradient-start: ${top}; background-gradient-end: ${bottom};`;
      this._syncBlurMask(bottomOpacity, blendStrength(compensate, darkText));
    } else {
      const top = `rgba(${r}, ${g}, ${b}, ${opacity})`;
      this._style = `background-color: ${top};`;
      this._syncBlurMask(null);
    }

    // Each section of the panel casts one shadow from all it draws.
    const shadowEnabled = this._shadowEnabled();
    this._syncTextShadow(shadowEnabled);

    if (shadowEnabled) {
      this._syncShadowEffect(this._sectionShadows(panel, meanOpacity, compensate, strength, gradient));
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

      const samples = colors.map(c => [c.r, c.g, c.b]);
      const bg = prevalentColor(samples).join(", ");
      const maximized = this._hasMaximizedWindow();
      // Maximize state flips before the window animation ends, so a quick
      // sample would change opacity ahead of the color. Leave that to the
      // settled sample so both crossfade in one transition.
      if (quick && maximized !== this._maximized) {
        return;
      }

      this._applyStyle(bg, maximized, samples);
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
