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

// Shadow and darkening calibration: dimBase is how much compensation at
// full strength dims any backdrop, however dark, on top of MAX_DIM for
// white; shadowHold is the share of the text shadow's configured opacity
// it keeps where the text has plenty of contrast, rising to all of it
// where the text has little, see shadowFactors(); and vivid the base HSV
// saturation boost of the panel color.
//
// The blur behind a gradient is deepened pixel by pixel, see
// blendStrength(): blend is how strongly at the top edge, always, and
// compBlend how much more at full brightness compensation; darkWeight is
// how strongly a black pixel is deepened relative to a white one; mul is
// the share of plain multiply against soft light, which darkens the
// weaker channels more and so makes colors more vivid (0 is all soft
// light); tint is the share
// of the configured opacity left to the flat panel color over the blur.
//
// Headroom keeps already vivid, bright colors from burning, i.e. turning a
// glaring pure hue instead of a deeper shade: weightMin and weightMax
// bound how much each channel of a blur pixel darkens relative to the
// amount, so the strongest one always darkens too and the weaker ones
// aren't crushed; headroom is how much a color's chroma (HSV saturation
// times value, 0-1) holds back the panel color's and the shadow's extra
// saturation.
export const R = {
  dimBase: 0.1, shadowHold: 0.7, vivid: 0.35,
  blend: 0.5, compBlend: 0.3, darkWeight: 0.5, mul: -1, tint: 0.3,
  weightMin: 0.7, weightMax: 1.2, headroom: 0.6,
};

// Return how much (0-1) of the extra saturation a color rgb (any scale up
// to full) still takes, by its chroma, see R.headroom.
function saturationRoom(rgb, full) {
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);

  return Math.max(0, 1 - R.headroom * (max - min) / full);
}

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

// The panel is always this much as bright as the backdrop, so it reads as
// a smooth deepening of the wallpaper rather than a flat copy of it.
const BASE_DARKEN = 0.88;

// The panel never goes darker than this share of the backdrop's
// brightness, so however bright the backdrop, it stays a tint of it
// rather than turning black.
const MIN_DARKEN = 1 / 3;

// HSV saturation boost of the panel color: always R.vivid, plus
// VIVID_DARK for each unit of darkening, so a deeper panel stays as
// colorful as the backdrop instead of looking dimmed.
export const VIVID_DARK = 0.6;

// Return how strongly (0-1) to deepen the blur behind a gradient panel at
// its top edge, for brightness compensation strength compensate (0-1).
// One flat panel color can't match a backdrop of several, e.g. a dark rock
// beside a blue sky, so the deepening is done on each blur pixel from its
// own color, see deepenPixel(). Dark text needs the backdrop bright.
export function blendStrength(compensate, darkText) {
  if (darkText) {
    return 0;
  }

  return R.blend + R.compBlend * compensate;
}

// Return those of the samples, taken evenly across width, that lie under
// the span from x0 to x1, widened by one sample spacing on both sides, so
// that a narrow section such as the clock still gets a few; else the one
// nearest to the span's middle.
export function samplesUnder(samples, x0, x1, width) {
  const step = width / samples.length;
  const under = samples.filter((_, i) => {
    const x = (i + 0.5) * step;

    return x >= x0 - step && x <= x1 + step;
  });

  if (under.length > 0) {
    return under;
  }

  const middle = Math.floor((x0 + x1) / 2 / step);

  return [samples[Math.min(samples.length - 1, Math.max(0, middle))]];
}

// Return the blur pixel rgb (0-1 channels) deepened at strength (0-1),
// as the blur shader in extension.js does; kept here to test the math.
// Brighter pixels are deepened more, as the white text needs. Within a
// pixel, a weaker channel loses more, in proportion to how far it is
// from white compared with the pixel's luma, like soft light against a
// dark layer, so colors turn more vivid with their hue kept, while a gray
// pixel just darkens by the amount. Soft light alone would deepen dark
// pixels most, the reverse of what white text needs. No channel loses
// more than two thirds, so the blur stays a tint, never black.
export function deepenPixel(rgb, strength) {
  const amount = strength * (R.darkWeight + (1 - R.darkWeight) * luma(...rgb));

  return deepenFactors(rgb, amount).map((k, i) => rgb[i] * k);
}

// Return the factor (0-1) each channel of the pixel rgb (0-1 channels) is
// multiplied by to deepen it by amount, see deepenPixel().
function deepenFactors(rgb, amount) {
  const l = luma(...rgb);

  return rgb.map(c => {
    const weight = Math.min(R.weightMax, Math.max(R.weightMin,
      R.mul + (1 - R.mul) * (1 - c) / Math.max(1 - l, 0.05)));

    return Math.max(MIN_DARKEN, 1 - amount * weight);
  });
}

// Return rgb with its HSV saturation boosted for a color darkened by dark
// (0-1). The strongest channel stays, the weaker ones move away from it,
// so the hue holds and grays stay gray. This only ever lowers channels,
// so it never raises the luma past a cap computed before.
function vivid(rgb, dark) {
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);

  if (max === min) {
    return [...rgb];
  }

  // Stop at full saturation, where the weakest channel reaches 0.
  const boost = Math.min(1 + (R.vivid + VIVID_DARK * dark) * saturationRoom(rgb, 255), max / (max - min));

  return rgb.map(c => max - (max - c) * boost);
}

// Return the backdrop color bg darkened to k of its brightness and made
// the more vivid the darker it gets.
function deepen(bg, k) {
  return vivid(bg.map(c => c * k), 1 - k).map(Math.floor);
}

// Return the panel { rgb: [r, g, b], darkText } for the sampled backdrop
// color bg, opacity (0-1), brightness compensation strength (0-1),
// text-contrast strength (0-1), whether to switch to dark text instead of
// darkening the color and whether the panel is a gradient. The panel is
// always a vivid, darker shade of the backdrop, between BASE_DARKEN and
// MIN_DARKEN of its brightness, never black.
export function panelColor(bg, opacity, compensate, strength, invert, gradient) {
  const backdropLuma = luma(...bg);
  let k = BASE_DARKEN;

  if (compensate > 0 && opacity > 0) {
    // A backdrop close in brightness to the white text needs a darker
    // panel, a dark one barely any, so dim what's seen through the panel,
    // the blend of it and the backdrop, in proportion to the color's
    // brightness, by up to MAX_DIM for white at full strength. The panel
    // can only dim the blend by its own opacity, so a translucent panel
    // darkens its color more for the same dimming.
    const dim = compensate * (R.dimBase + MAX_DIM * backdropLuma / 255);
    k = Math.min(k, 1 - dim / opacity);
  }

  k = Math.max(MIN_DARKEN, k);
  // A gradient fades into the backdrop around the text, so there judge
  // the backdrop itself, not its blend with a compensated, darker color.
  let textLuma = opacity * luma(...deepen(bg, k)) + (1 - opacity) * backdropLuma;

  if (gradient) {
    textLuma = backdropLuma;
  }

  // Pick the text color that reads better where the text sits, leaning
  // to white by 1 / strength: at full strength whichever has more
  // contrast, at a third black needs three times white's, at zero never.
  // Compensation only helps white text, so dark text gets the backdrop
  // darkened by the base amount alone.
  if (invert && strength > 0 && contrast(0, textLuma) > contrast(255, textLuma) / strength) {
    return { rgb: deepen(bg, BASE_DARKEN), darkText: true, contrast: contrast(0, textLuma) };
  }

  // The panel text is white, so darken the color until the result keeps
  // enough contrast. A translucent panel shows roughly the sampled color
  // beneath it, so cap the blend of both rather than the color alone.
  // MIN_DARKEN wins over the cap, so a very bright backdrop behind a
  // translucent panel keeps a tinted panel and leaves the rest of the
  // contrast to the text shadow.
  const maxLuma = 255 - (255 - MIN_MAX_LUMA) * strength;

  if (opacity > 0 && backdropLuma > 0) {
    const cap = (maxLuma - (1 - opacity) * backdropLuma) / (opacity * backdropLuma);
    k = Math.max(MIN_DARKEN, Math.min(k, cap));
  }

  const rgb = deepen(bg, k);
  textLuma = opacity * luma(...rgb) + (1 - opacity) * backdropLuma;

  if (gradient) {
    textLuma = backdropLuma;
  }

  return { rgb, darkText: false, contrast: contrast(255, textLuma) };
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

// Return the text shadow, as the [r, g, b] factors (0-1) the shadow
// multiplies what's behind it by where it's full, for the color rgb seen
// behind the text, text with contrast textContrast, and the configured
// shadow opacity and vibrance (0-1). At no vibrance it's a neutral dark,
// like macOS's transparent menu bar, darkening every channel alike. With
// vibrance it's a deeper tone of the backdrop's own hue: the strongest
// channel still darkens by the opacity, the weaker ones further, so what's
// behind the text turns a more saturated shade, e.g. navy on a blue sky
// rather than gray. The darker the shadow, the more it saturates, fully
// at full vibrance once it darkens by half, so a faint shadow only
// faintly tints and none leaves the backdrop as is. The shadow is there to rescue contrast, so it's the stronger
// the less contrast the text has: shadowHold of the opacity at 10:1, all
// of it at 2:1.
export function shadowFactors(rgb, textContrast, opacity, vibrance) {
  const need = Math.min(1, Math.max(0, Math.log(10 / textContrast) / Math.log(10 / 2)));
  const k = 1 - opacity * (R.shadowHold + (1 - R.shadowHold) * need);
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const round = f => Math.round(f * 100) / 100;

  if (max === min) {
    return [k, k, k].map(round);
  }

  // At full saturation the weakest channel reaches 0, so scale each
  // channel's distance below the strongest by max / (max - min).
  return rgb.map(c => {
    const saturated = max - (max - c) * max / (max - min);
    const target = c + (saturated - c) * vibrance * saturationRoom(rgb, 255) * Math.min(1, 2 * (1 - k));

    if (c === 0) {
      return round(k);
    }

    return round(k * target / c);
  });
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
