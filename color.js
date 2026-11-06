// -*- coding: utf-8-unix -*-

// Brightest background (0-255 luma) behind the white panel text at full
// text-contrast strength. #767676, with a luma of 118, is the lightest gray
// with 4.5:1 contrast against white. At zero strength the cap is 255 (off).
export const MIN_MAX_LUMA = 118;

export const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// How much brightness compensation at full strength dims what's seen
// through the panel over white; darker colors are dimmed proportionally
// less.
const MAX_DIM = 0.4;

// Darkened colors look muddy, so push the channels away from their gray by
// the given factor (1 keeps the color). This keeps the luma, so contrast
// caps computed before still hold.
function saturate(rgb, amount) {
  const gray = luma(...rgb);
  let [r, g, b] = rgb.map(c => Math.min(255, Math.max(0, gray + (c - gray) * amount)));
  // Clamping a channel at 0 raises the luma, so scale back down to gray's.
  const boosted = luma(r, g, b);

  if (boosted > gray) {
    [r, g, b] = [r, g, b].map(c => c * gray / boosted);
  }

  return [r, g, b];
}

// Return the panel { rgb: [r, g, b], darkText } for the sampled backdrop
// color bg, opacity (0-1), brightness compensation strength (0-1),
// text-contrast strength (0-1), whether to switch to dark text instead of
// darkening the color and whether the panel is a gradient.
export function panelColor(bg, opacity, compensate, strength, invert, gradient) {
  let [r, g, b] = bg;

  if (compensate > 0 && opacity > 0) {
    // A backdrop close in brightness to the white text needs a darker
    // panel, a dark one barely any, so dim what's seen through the panel,
    // the blend of it and the backdrop, in proportion to the color's
    // brightness, by up to MAX_DIM for white at full strength. The panel
    // can only dim the blend by its own opacity, so a translucent panel
    // darkens its color more for the same dimming, down to black.
    // Darkening washes colors out, so boost saturation slightly too. Keep
    // at least a third of the brightness, so the panel stays tinted rather
    // than black, at the cost of dimming less on a very translucent panel.
    const dim = compensate * MAX_DIM * luma(r, g, b) / 255;
    const k = Math.max(1 / 3, 1 - dim / opacity);
    [r, g, b] = saturate([r, g, b].map(c => c * k), 1 + 0.5 * (1 - k)).map(Math.round);
  }

  // The panel text is white, so darken the color until the result keeps
  // enough contrast. A translucent panel shows roughly the sampled color
  // beneath it, so cap the blend of both rather than the color alone.
  // If the backdrop alone is too bright, this goes as dark as it can.
  const panelLuma = luma(r, g, b);
  const backdropLuma = luma(...bg);
  const blendedLuma = opacity * panelLuma + (1 - opacity) * backdropLuma;
  const maxLuma = 255 - (255 - MIN_MAX_LUMA) * strength;

  // A gradient fades into the backdrop around the text, so there judge
  // the backdrop itself, not its blend with a compensated, darker color.
  let textLuma = blendedLuma;

  if (gradient) {
    textLuma = backdropLuma;
  }

  // Pick the text color that reads better where the text sits, leaning
  // to white by 1 / strength: at full strength whichever has more
  // contrast, at a third black needs three times white's, at zero never.
  // Dark text needs no darkening, so it gets the uncompensated color.
  if (invert && strength > 0 && contrast(0, textLuma) > contrast(255, textLuma) / strength) {
    return { rgb: [...bg], darkText: true, contrast: contrast(0, textLuma) };
  }

  if (blendedLuma > maxLuma && opacity > 0 && panelLuma > 0) {
    const k = Math.max(0, (maxLuma - (1 - opacity) * backdropLuma) / (opacity * panelLuma));
    // Boost saturation in proportion to how much was darkened, up to double.
    [r, g, b] = saturate([r, g, b].map(c => c * k), 2 - k);
    // Floor so rounding can't push the luma back over the cap.
    [r, g, b] = [r, g, b].map(Math.floor);
  }

  textLuma = opacity * luma(r, g, b) + (1 - opacity) * backdropLuma;

  if (gradient) {
    textLuma = backdropLuma;
  }

  return { rgb: [r, g, b], darkText: false, contrast: contrast(255, textLuma) };
}

// WCAG contrast ratio of two 0-255 lumas, approximating relative
// luminance with a 2.2 gamma.
export function contrast(a, b) {
  const [la, lb] = [a, b].map(l => Math.pow(l / 255, 2.2) + 0.05);

  return Math.max(la, lb) / Math.min(la, lb);
}

// Return the dark text [r, g, b] for the panel color rgb: a deep shade of
// it rather than pure black, so the text belongs to the wallpaper. A fifth
// of the brightness keeps it dark enough for the contrast that chose dark
// text, and the saturation boost keeps its hue from fading to gray.
export function darkTextColor(rgb) {
  return saturate(rgb.map(c => c * 0.2), 2).map(Math.round);
}

// Return the text-shadow [r, g, b, alpha] for the panel color rgb. Behind
// white text that's a darker tint of the panel color, and behind dark text
// a lighter one. Plain darkening would look the same as translucent black,
// so boost saturation to make the tint show. The shadow is there to rescue
// contrast, so it's the stronger the less contrast the text has: barely
// there at 10:1, full at 2:1.
export function shadowColor(rgb, darkText, textContrast) {
  const need = Math.min(1, Math.max(0, Math.log(10 / textContrast) / Math.log(10 / 2)));
  const alpha = Math.round((0.35 + 0.55 * need) * 100) / 100;

  if (darkText) {
    return [...rgb.map(c => Math.round(c + (255 - c) * 0.75)), alpha];
  }

  return [...saturate(rgb.map(c => c * 0.35), 3).map(Math.round), alpha];
}

// Samples this far apart, as the sum of channel differences, no longer
// count as the same color; closer ones count the more the closer they are.
const SIMILAR_DISTANCE = 64;

// How many times a dark sample counts against a light one when choosing
// between the darker and the lighter half of the samples. The panel text
// is white, so a dark tone keeps it readable across the whole width; at 2
// a dark area wins once it covers a third of the width.
const DARK_PREFERENCE = 2;

// Return the most prevalent of the [r, g, b] samples. First split them at
// the luma halfway between the darkest and the lightest, and keep the
// darker half if it holds its share of the samples, counted by
// DARK_PREFERENCE, else the lighter half. Splitting by tone first lets a
// dark area win even if it's dark in many different colors, e.g. a rock
// going from black to slate, against a sky all of one blue. Then within
// that half, return the sample in the densest crowd of similar samples,
// each counting the more the closer it is. Counting near and far ones
// alike would let a stray sample between two crowds, e.g. a brown leaf
// between green trees and a dark window, reach both and win. It's a
// sample itself, not a blend, so the panel gets a color that's really on
// screen. On an exact tie, prefer the darker sample.
export function prevalentColor(samples) {
  const distance = (a, b) => a.reduce((sum, c, i) => sum + Math.abs(c - b[i]), 0);
  const lumas = samples.map(c => luma(...c));
  const split = (Math.min(...lumas) + Math.max(...lumas)) / 2;
  const dark = samples.filter((_, i) => lumas[i] <= split);
  const light = samples.filter((_, i) => lumas[i] > split);
  let group = light;

  if (dark.length * DARK_PREFERENCE >= light.length) {
    group = dark;
  }

  let best = null;
  let bestScore = -1;

  for (const sample of group) {
    const score = group.reduce((sum, s) =>
      sum + Math.max(0, 1 - distance(s, sample) / SIMILAR_DISTANCE), 0);
    let better = score > bestScore;

    if (score === bestScore) {
      better = luma(...sample) < luma(...best);
    }

    if (better) {
      best = sample;
      bestScore = score;
    }
  }

  return best;
}

// libadwaita's accent colors, except slate, the fallback for gray images.
const ACCENTS = {
  blue: [0x35, 0x84, 0xe4],
  teal: [0x21, 0x90, 0xa4],
  green: [0x3a, 0x94, 0x4a],
  yellow: [0xc8, 0x88, 0x00],
  orange: [0xed, 0x5b, 0x00],
  red: [0xe6, 0x2d, 0x42],
  pink: [0xd5, 0x61, 0x99],
  purple: [0x91, 0x41, 0xac],
};

// Hue in degrees, saturation and value (0-1) of an RGB color.
function hsv(r, g, b) {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);

  if (d === 0) {
    return [0, 0, max / 255];
  }

  let h = 0;

  if (max === r) {
    h = ((g - b) / d + 6) % 6;
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }

  return [h * 60, d / max, max / 255];
}

const ACCENT_HUES = Object.entries(ACCENTS).map(([name, rgb]) => [name, hsv(...rgb)[0]]);

// Return the accent-color name closest to the image's most prominent hue.
// pixels is RGB(A) bytes, with channels per pixel and rowstride per row.
export function accentFromPixels(pixels, width, height, channels, rowstride) {
  const weights = {};
  let total = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * rowstride + x * channels;
      const [h, s, v] = hsv(pixels[i], pixels[i + 1], pixels[i + 2]);

      // Dark and grayish pixels carry no hue worth matching.
      if (s < 0.25 || v < 0.2) {
        continue;
      }

      let best = null;
      let bestDistance = Infinity;

      for (const [name, hue] of ACCENT_HUES) {
        const diff = Math.abs(h - hue);
        const distance = Math.min(diff, 360 - diff);

        if (distance < bestDistance) {
          best = name;
          bestDistance = distance;
        }
      }

      weights[best] = (weights[best] ?? 0) + s * v;
      total += s * v;
    }
  }

  // An image with little color gets the neutral accent.
  if (total < 0.05 * width * height) {
    return "slate";
  }

  return Object.keys(weights).reduce((a, b) => {
    if (weights[b] > weights[a]) {
      return b;
    }

    return a;
  });
}
