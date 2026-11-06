import { panelColor, luma } from "./color.js";
const s = {op: 0.35, bottom: 0, grad: true, strength: 0.35, invert: true};
const cases = {white:[240,240,240], paleSky:[196,204,214], pink:[210,90,150], sky:[100,150,190], gray:[128,128,128], forest:[45,60,40], darkBlue:[30,40,80]};
for (const [n,c] of Object.entries(cases)) {
  const row = [0,0.25,0.5,0.75,1].map(comp => { const p = panelColor(c, (s.op+s.bottom)/2, comp, s.strength, s.invert, s.grad); return p.rgb.join(",") + (p.darkText?"D":""); });
  print(n.padEnd(9), row.join("  |  "));
}
