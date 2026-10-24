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
