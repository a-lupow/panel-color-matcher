// -*- coding: utf-8-unix -*-
// Run with: gjs -m test.js

import { MIN_MAX_LUMA, accentFromPixels, contrast, darkTextColor, luma, panelColor, prevalentColor, shadowColor } from "./color.js";

const assert = (ok, message) => {
  if (!ok) {
    throw new Error(message);
  }
};

for (const c of [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0]]) {
  assert(luma(...panelColor(c, 1, 0, 1).rgb) <= MIN_MAX_LUMA,
         `${c} must be darkened for contrast`);
}

// Translucent: the blend of panel and backdrop must stay under the cap.
const bg = [255, 255, 0];
assert(0.5 * luma(...panelColor(bg, 0.5, 0, 1).rgb) + 0.5 * luma(...bg) <= Math.max(MIN_MAX_LUMA, 0.5 * luma(...bg)),
       "translucent yellow must be darkened as far as it can");
assert(panelColor([0, 0, 0], 0.5, 1, 1).rgb.join() === "0,0,0",
       "black must stay black");
assert(panelColor([255, 255, 255], 1, 0, 0).rgb.join() === "255,255,255",
       "zero strength must not darken");
// Compensation dims the blend of panel and backdrop, bright colors more.
const blendLuma = (rgb, bg, opacity) => opacity * luma(...rgb) + (1 - opacity) * luma(...bg);
const white = [255, 255, 255];
assert(Math.abs(blendLuma(panelColor(white, 1, 1, 0).rgb, white, 1) - 255 * 0.6) < 1,
       "full compensation must dim white by MAX_DIM");
const darkBlue = [30, 40, 80];
const dimmedBlue = panelColor(darkBlue, 1, 1, 0).rgb;
assert(luma(...dimmedBlue) / luma(...darkBlue) > 0.9,
       "a dark color must barely darken");
const pink = [210, 90, 150];
const halfPink = panelColor(pink, 0.5, 1, 0).rgb;
assert(Math.abs(blendLuma(halfPink, pink, 0.5) - luma(...pink) * (1 - 0.4 * luma(...pink) / 255)) < 1,
       "a translucent panel must darken its color more for the same dimming");
assert(halfPink[0] / Math.max(1, halfPink[1]) > pink[0] / pink[1],
       "compensation must boost saturation");
assert(panelColor([128, 128, 128], 0.5, 1, 0).rgb.every(c => c === panelColor([128, 128, 128], 0.5, 1, 0).rgb[0]),
       "compensated gray must stay gray");
assert(panelColor(pink, 0, 1, 0).rgb.join() === pink.join(),
       "a transparent panel can't compensate");

// Inversion keeps a bright color and switches to dark text instead.
const inverted = panelColor([255, 255, 0], 1, 0, 1, true);
assert(inverted.darkText && inverted.rgb.join() === "255,255,0",
       "bright yellow must keep its color with dark text");
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
assert(paleSky.rgb.join() === "196,204,214",
       "dark text must get the uncompensated color");

// Shadows tint the panel color darker for white text, lighter for dark.
const [sr, sg, sb] = shadowColor([200, 100, 50], false, 3);
assert(luma(sr, sg, sb) < luma(200, 100, 50) / 2 && sr > sg && sg > sb,
       "the shadow must be a darker tint of the panel color");
assert(luma(...shadowColor([200, 100, 50], true, 3).slice(0, 3)) > luma(200, 100, 50),
       "the dark-text shadow must be lighter than the panel color");
assert(shadowColor([128, 128, 128], false, 3).slice(0, 3).every(c => c === 45),
       "a gray panel must get a gray shadow");
// The shadow is the stronger the less contrast the text has.
assert(shadowColor([40, 40, 40], false, 12)[3] === 0.35,
       "high contrast must get a faint shadow");
assert(shadowColor([180, 180, 180], false, 1.5)[3] === 0.9,
       "low contrast must get a strong shadow");
assert(shadowColor([180, 180, 180], false, 3)[3] > shadowColor([180, 180, 180], false, 5)[3],
       "less contrast must get a stronger shadow");

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
