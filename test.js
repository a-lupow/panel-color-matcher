// -*- coding: utf-8-unix -*-
// Run with: gjs -m test.js

import { MIN_MAX_LUMA, accentFromPixels, luma, panelColor } from "./color.js";

const assert = (ok, message) => {
  if (!ok) {
    throw new Error(message);
  }
};

for (const c of [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0]]) {
  assert(luma(...panelColor(c, 1, false, 1).rgb) <= MIN_MAX_LUMA,
         `${c} must be darkened for contrast`);
}

// Translucent: the blend of panel and backdrop must stay under the cap.
const bg = [255, 255, 0];
assert(0.5 * luma(...panelColor(bg, 0.5, false, 1).rgb) + 0.5 * luma(...bg) <= Math.max(MIN_MAX_LUMA, 0.5 * luma(...bg)),
       "translucent yellow must be darkened as far as it can");
assert(panelColor([0, 0, 0], 0.5, true, 1).rgb.join() === "0,0,0",
       "black must stay black");
assert(panelColor([255, 255, 255], 1, false, 0).rgb.join() === "255,255,255",
       "zero strength must not darken");
const compensated = panelColor([200, 100, 50], 0.5, true, 0).rgb;
assert(Math.abs(luma(...compensated) - luma(100, 50, 25)) < 1,
       "compensation must scale brightness by opacity");
assert(compensated[0] - compensated[2] > 100 - 25,
       "compensation must boost saturation");
assert(panelColor([200, 100, 50], 1, true, 0).rgb.join() === "200,100,50",
       "opaque compensation must keep the color");
assert(panelColor([128, 128, 128], 0.5, true, 0).rgb.join() === "64,64,64",
       "compensated gray must stay gray");

// Inversion keeps a bright color and switches to dark text instead.
const inverted = panelColor([255, 255, 0], 1, false, 1, true);
assert(inverted.darkText && inverted.rgb.join() === "255,255,0",
       "bright yellow must keep its color with dark text");
assert(!panelColor([40, 40, 120], 1, false, 1, true).darkText,
       "dark blue must keep white text");
assert(panelColor([240, 240, 240], 0, false, 1, true).darkText,
       "a transparent panel over a bright backdrop must get dark text");
assert(!panelColor([200, 200, 200], 1, false, 0, true).darkText,
       "zero strength must not invert");

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
