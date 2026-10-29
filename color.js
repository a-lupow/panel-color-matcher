// -*- coding: utf-8-unix -*-

// Brightest background (0-255 luma) behind the white panel text at full
// text-contrast strength. #767676, with a luma of 118, is the lightest gray
// with 4.5:1 contrast against white. At zero strength the cap is 255 (off).
export const MIN_MAX_LUMA = 118;

export const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// Return the panel [r, g, b] for the sampled backdrop color bg, opacity
// (0-1), brightness compensation and text-contrast strength (0-1).
export function panelColor(bg, opacity, compensate, strength) {
  let [r, g, b] = bg;

  if (compensate) {
    // A translucent panel blends with the similar colors beneath it and
    // washes out, so darken the color in proportion to the transparency.
    [r, g, b] = [r, g, b].map(c => Math.round(c * opacity));
  }

  // The panel text is white, so darken the color until the result keeps
  // enough contrast. A translucent panel shows roughly the sampled color
  // beneath it, so cap the blend of both rather than the color alone.
  // If the backdrop alone is too bright, this goes as dark as it can.
  const panelLuma = luma(r, g, b);
  const backdropLuma = luma(...bg);
  const blendedLuma = opacity * panelLuma + (1 - opacity) * backdropLuma;
  const maxLuma = 255 - (255 - MIN_MAX_LUMA) * strength;

  if (blendedLuma > maxLuma && opacity > 0 && panelLuma > 0) {
    const k = Math.max(0, (maxLuma - (1 - opacity) * backdropLuma) / (opacity * panelLuma));
    [r, g, b] = [r, g, b].map(c => c * k);
    // Darkening makes colors look muddy, so boost saturation in proportion
    // to how much was darkened, up to double. Pushing channels away from
    // their gray keeps the luma, so the contrast cap still holds.
    const gray = luma(r, g, b);
    const vibrance = 1 + (1 - k);
    [r, g, b] = [r, g, b].map(c => Math.min(255, Math.max(0, gray + (c - gray) * vibrance)));
    // Clamping a channel at 0 raises the luma, so scale back down to gray's.
    const boosted = luma(r, g, b);

    if (boosted > gray) {
      [r, g, b] = [r, g, b].map(c => c * gray / boosted);
    }

    // Floor so rounding can't push the luma back over the cap.
    [r, g, b] = [r, g, b].map(Math.floor);
  }

  return [r, g, b];
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
