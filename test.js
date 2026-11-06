// -*- coding: utf-8-unix -*-
// Run with: gjs -m test.js

import {
  MIN_MAX_LUMA, R, accentFromPixels, blendStrength, contrast, darkTextColor, deepenPixel, luma, panelColor,
  prevalentColor, samplesUnder, shadowColor,
} from "./color.js";

const assert = (ok, message) => {
  if (!ok) {
    throw new Error(message);
  }
};

for (const c of [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0]]) {
  assert(luma(...panelColor(c, 1, 0, 1).rgb) <= MIN_MAX_LUMA,
         `${c} must be darkened for contrast`);
}

// Translucent: a backdrop too bright for the cap darkens only to a
// vivid tint of itself, never to black.
const bg = [255, 255, 0];
const halfYellow = panelColor(bg, 0.5, 0, 1).rgb;
assert(Math.abs(luma(...halfYellow) - luma(...bg) / 3) < 1 && halfYellow[2] === 0,
       "translucent yellow must stop at a third of its brightness, still yellow");
assert(panelColor([0, 0, 0], 0.5, 1, 1).rgb.join() === "0,0,0",
       "black must stay black");
// The panel is always a bit darker than the backdrop, and more vivid.
assert(panelColor([255, 255, 255], 1, 0, 0).rgb.join() === "224,224,224",
       "zero strength must darken by the base amount only");
const midSky = [100, 150, 190];
const deepSky = panelColor(midSky, 1, 0, 0).rgb;
assert(luma(...deepSky) < luma(...midSky) && Math.max(...deepSky) >= Math.floor(0.85 * Math.max(...midSky)),
       "the panel must be a bit darker than the backdrop, its brightest channel barely");
assert((deepSky[2] - deepSky[0]) / deepSky[2] > (midSky[2] - midSky[0]) / midSky[2],
       "the panel must be more vivid than the backdrop");
assert(luma(...panelColor([12, 14, 18], 1, 1, 1).rgb) > 0,
       "a near-black backdrop must keep a tint");
// Compensation dims the blend of panel and backdrop, bright colors more.
const blendLuma = (rgb, bg, opacity) => opacity * luma(...rgb) + (1 - opacity) * luma(...bg);
const white = [255, 255, 255];
assert(Math.abs(blendLuma(panelColor(white, 1, 1, 0).rgb, white, 1) - 255 * (0.6 - R.dimBase)) < 1,
       "full compensation must dim white by MAX_DIM plus dimBase");
const darkBlue = [30, 40, 80];
const dimmedBlue = panelColor(darkBlue, 1, 1, 0).rgb;
assert(luma(...dimmedBlue) < luma(...panelColor(darkBlue, 1, 0, 0).rgb),
       "compensation must darken even a dark color");
assert(luma(...dimmedBlue) > 0.6 * luma(...panelColor(darkBlue, 1, 0, 0).rgb),
       "an opaque dark color must darken only slightly");
const pink = [210, 90, 150];
const halfPink = panelColor(pink, 0.5, 1, 0).rgb;
assert(blendLuma(halfPink, pink, 0.5) <= luma(...pink) * (1 - 0.4 * luma(...pink) / 255) + 1,
       "a translucent panel must darken its color more for the same dimming");
assert(luma(...halfPink) < luma(...panelColor(pink, 1, 1, 0).rgb),
       "a translucent panel must get the darker color");
assert(halfPink[0] / Math.max(1, halfPink[1]) > pink[0] / pink[1],
       "compensation must boost saturation");
assert(panelColor([128, 128, 128], 0.5, 1, 0).rgb.every(c => c === panelColor([128, 128, 128], 0.5, 1, 0).rgb[0]),
       "compensated gray must stay gray");
assert(panelColor(pink, 0, 1, 0).rgb.join() === panelColor(pink, 1, 0, 0).rgb.join(),
       "a transparent panel can't compensate");
// However bright the backdrop and however translucent the panel, the
// contrast cap stops at a tint, not black.
for (const c of [[255, 255, 255], [255, 255, 0], [210, 90, 150]]) {
  for (const opacity of [0.1, 0.35, 0.5, 1]) {
    assert(Math.max(...panelColor(c, opacity, 1, 1).rgb) >= Math.floor(Math.max(...c) / 3),
           `${c} at ${opacity} must keep a third of its brightest channel`);
  }
}

// Inversion keeps a bright color and switches to dark text instead.
const inverted = panelColor([255, 255, 0], 1, 0, 1, true);
assert(inverted.darkText && inverted.rgb.join() === panelColor([255, 255, 0], 1, 0, 0).rgb.join(),
       "bright yellow must keep its base-darkened color with dark text");
assert(!panelColor([40, 40, 120], 1, 0, 1, true).darkText,
       "dark blue must keep white text");
assert(panelColor([240, 240, 240], 0, 0, 1, true).darkText,
       "a transparent panel over a bright backdrop must get dark text");
assert(!panelColor([200, 200, 200], 1, 0, 0, true).darkText,
       "zero strength must not invert");
// Compensation darkens the blend under the cap, but the backdrop is bright.
assert(!panelColor([200, 200, 200], 1, 1, 0.5, true, false).darkText,
       "a solid compensated panel must judge the blend");
assert(panelColor([200, 200, 200], 1, 1, 0.5, true, true).darkText,
       "a gradient must judge the backdrop");
// The text color follows contrast, leaning to white as strength drops.
assert(panelColor([196, 204, 214], 0.175, 0.6, 0.35, true, true).darkText,
       "a pale sky must get dark text");
assert(!panelColor([140, 140, 140], 0.175, 0, 0.35, true, true).darkText,
       "a mid gray must keep white text at a third strength");
assert(panelColor([140, 140, 140], 0.175, 0, 1, true, true).darkText,
       "a mid gray must get dark text at full strength");
const paleSky = panelColor([196, 204, 214], 0.175, 0.6, 0.35, true, true);
assert(paleSky.rgb.join() === panelColor([196, 204, 214], 1, 0, 0).rgb.join(),
       "dark text must get the uncompensated, base-darkened color");

// The shadow is the panel color itself, so it blends in smoothly.
assert(shadowColor([184, 61, 122], 3).slice(0, 3).join() === "184,61,122",
       "the shadow must be the panel color");
// The shadow is the stronger the less contrast the text has.
assert(shadowColor([40, 40, 40], 12)[3] === R.minAlpha && R.minAlpha >= 0.5,
       "high contrast must still get a visible shadow");
assert(shadowColor([180, 180, 180], 1.5)[3] === R.maxAlpha,
       "low contrast must get a strong shadow");
assert(shadowColor([180, 180, 180], 3)[3] > shadowColor([180, 180, 180], 5)[3],
       "less contrast must get a stronger shadow");

// The blur deepens pixel by pixel, always a bit and more with compensation.
assert(blendStrength(0, false) > 0, "the blur must always deepen a bit");
assert(blendStrength(1, false) > blendStrength(0, false), "compensation must deepen the blur more");
assert(blendStrength(1, true) === 0, "dark text must not deepen the blur");
const px = c => c.map(v => v / 255);
const lumaOf = c => luma(...c);
const sky1 = px([90, 136, 173]);
const deepSky1 = deepenPixel(sky1, 0.6);
assert(lumaOf(deepSky1) < lumaOf(sky1), "a deepened pixel must be darker");
assert(deepSky1[0] / deepSky1[2] < sky1[0] / sky1[2], "a deepened pixel must be more vivid in its own hue");
const cloud = px([220, 226, 234]);
const rock3 = px([26, 42, 53]);
assert(1 - lumaOf(deepenPixel(cloud, 0.6)) / lumaOf(cloud) > 1 - lumaOf(deepenPixel(rock3, 0.6)) / lumaOf(rock3),
       "a bright pixel must deepen more than a dark one");
assert(deepenPixel(px([128, 128, 128]), 0.6).every((c, _, a) => Math.abs(c - a[0]) < 1e-9),
       "a gray pixel must stay gray");
assert(deepenPixel(px([255, 255, 255]), 1).every(c => c >= 1 / 3 - 1e-9) &&
       deepenPixel(rock3, 1).every((c, i) => c >= rock3[i] / 3 - 1e-9),
       "no pixel must go darker than a third");

// Each section shades from the samples beneath it.
const strip = [...Array(5).fill([26, 42, 53]), ...Array(10).fill([90, 136, 173]), [9, 17, 26]];
assert(samplesUnder(strip, 700, 900, 1600).every(c => c[2] === 173),
       "the middle of the strip must get only the sky");
assert(samplesUnder(strip, 0, 300, 1600).some(c => c[2] === 53),
       "the left of the strip must get the rock");
assert(samplesUnder(strip, 790, 800, 1600).length >= 2,
       "a narrow section must still get a few samples");

// Dark text is a deep shade of the panel color, still well readable.
const ink = darkTextColor([196, 204, 214]);
assert(ink[2] > ink[0] && luma(...ink) > 0, "dark text must keep the panel's hue");
assert(contrast(luma(...ink), luma(196, 204, 214)) > 7,
       "dark text must keep strong contrast");

// The most common color wins, as one of the samples, never a blend.
const teal = [[94, 111, 118], [102, 117, 124], [106, 120, 128], [110, 125, 132],
              [113, 128, 135], [116, 131, 138], [118, 131, 136], [122, 132, 131]];
const peach = [[251, 207, 182], [234, 190, 165], [222, 166, 139], [234, 175, 145]];
const prevalent = prevalentColor([...teal, ...peach]);
assert(teal.includes(prevalent), "the prevalent teal must win over a bright spot");
const light = Array(8).fill([240, 240, 240]);
const wallpaper = Array(8).fill([120, 130, 140]);
assert(prevalentColor([...wallpaper, ...light]).join() === "120,130,140",
       "of two equal areas, the darker must win");
// Dark rock over a third of the width, lighter sky over the rest.
const rock = [[13, 30, 40], [15, 29, 40], [14, 30, 38], [35, 51, 59], [27, 42, 47], [17, 29, 41]];
const sky = [[113, 160, 196], [101, 149, 187], [119, 166, 199], [104, 152, 192], [89, 140, 183],
             [91, 137, 180], [86, 135, 177], [83, 131, 172], [80, 127, 166]];
assert(rock.includes(prevalentColor([...rock, ...sky])),
       "a dark area must win over a somewhat larger light one");
assert(prevalentColor([...Array(4).fill([20, 20, 20]), ...Array(12).fill([200, 200, 200])]).join() === "200,200,200",
       "a dark area under a third of the width must not win");
// A rock from black to slate over 6 of 16 samples, the rest one sky blue.
const rock2 = [[17, 35, 48], [0, 3, 2], [25, 42, 53], [2, 5, 20], [37, 49, 56], [6, 13, 21]];
const sky2 = [[98, 140, 173], [99, 140, 173], [90, 135, 169], [97, 142, 181], [81, 128, 168],
              [78, 125, 165], [77, 122, 162], [75, 120, 158], [72, 116, 154], [70, 112, 148]];
assert(rock2.includes(prevalentColor([...rock2, ...sky2])),
       "a dark area of many colors must win over a uniform lighter one");
// A stray brown between forest greens and a dark window reaches both, but
// must not win over either.
const forest = [[101, 106, 109], [102, 107, 110], [108, 113, 116], [45, 47, 43], [47, 50, 47],
                [49, 51, 47], [19, 25, 32], [19, 25, 32], [19, 25, 32], [19, 25, 32], [45, 47, 42],
                [37, 39, 35], [17, 18, 3], [44, 28, 18], [37, 41, 34], [4, 7, 1]];
assert(prevalentColor(forest).join() !== "44,28,18",
       "a stray sample between two crowds must not win");

// A 2x2 RGB image of one color, or with the given four colors.
const image = (...colors) => {
  const pixels = Array.from({ length: 4 }, (_, i) => colors[i % colors.length]).flat();

  return accentFromPixels(pixels, 2, 2, 3, 6);
};
assert(image([0x35, 0x84, 0xe4]) === "blue", "blue must match blue");
assert(image([250, 100, 0]) === "orange", "orange must match orange");
assert(image([240, 20, 30]) === "red", "red must match red");
assert(image([255, 10, 80]) === "red", "red wraps around 360 degrees");
assert(image([128, 128, 128]) === "slate", "gray must fall back to slate");
assert(image([5, 5, 40]) === "slate", "near-black must fall back to slate");
assert(image([40, 200, 60], [40, 200, 60], [40, 200, 60], [140, 60, 180]) === "green",
       "the most prominent hue must win");

print("ok");
