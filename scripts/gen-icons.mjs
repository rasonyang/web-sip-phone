import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";

// Extension icons mirror the in-page widget: the lucide "headset" glyph (identical path to
// the one rendered in src/content/view.ts) with the green status dot at its top-right.
// Rasterized from SVG so every size stays crisp and the glyph never drifts from the UI.
// The viewBox padding keeps the artwork inside ~a 96px square at 128px, per store guidance.

const ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2.5 -2.5 29 29">
  <g fill="none" stroke="#404040" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5a9 9 0 0 1 18 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>
    <path d="M21 16v2a4 4 0 0 1-4 4h-5"/>
  </g>
  <circle cx="20.5" cy="3.5" r="4.4" fill="#ffffff"/>
  <circle cx="20.5" cy="3.5" r="3.2" fill="#16a34a"/>
</svg>`;

mkdirSync("static/icons", { recursive: true });
for (const size of [16, 48, 128]) {
  const png = new Resvg(ICON_SVG, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(`static/icons/icon-${size}.png`, png);
}
console.log("Icons written to static/icons/");
