import { PNG } from "pngjs";
import { mkdirSync, writeFileSync } from "node:fs";

// Desk-phone glyph matching the in-page widget: handset bar + body with keypad,
// green status dot top-right. Drawn per-pixel from shape predicates.

const PHONE = [64, 64, 64, 255]; // neutral-700
const GREEN = [34, 197, 94, 255]; // green-500
const WHITE = [255, 255, 255, 255];

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return Math.hypot(x - cx, y - cy) <= r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
}

function drawIcon(size) {
  const png = new PNG({ width: size, height: size });
  const s = (f) => f * size;
  const keypadCols = [0.36, 0.5, 0.64].map(s);
  const keypadRows = [0.52, 0.66].map(s);
  const dotC = { x: s(0.8), y: s(0.2) };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2;
      const px = x + 0.5;
      const py = y + 0.5;
      let rgba = [0, 0, 0, 0];

      const handset = inRoundedRect(px, py, s(0.08), s(0.14), s(0.92), s(0.32), s(0.08));
      const body = inRoundedRect(px, py, s(0.2), s(0.32), s(0.8), s(0.9), s(0.08));
      if (handset || body) rgba = PHONE;

      const keypad = keypadCols.some((cx) => keypadRows.some((cy) => Math.hypot(px - cx, py - cy) <= s(0.04)));
      if (keypad) rgba = WHITE;

      const dDot = Math.hypot(px - dotC.x, py - dotC.y);
      if (dDot <= s(0.19)) rgba = WHITE; // ring separating dot from handset
      if (dDot <= s(0.15)) rgba = GREEN;

      [png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]] = rgba;
    }
  }
  return PNG.sync.write(png);
}

mkdirSync("static/icons", { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(`static/icons/icon-${size}.png`, drawIcon(size));
}
console.log("Icons written to static/icons/");
