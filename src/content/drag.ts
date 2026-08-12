import type { DotPosition } from "../shared/config.js";

export function snapToEdge(centerX: number, centerY: number, viewportW: number, viewportH: number): DotPosition {
  const side: DotPosition["side"] = centerX < viewportW / 2 ? "left" : "right";
  const y = Math.min(0.95, Math.max(0.05, centerY / viewportH));
  return { side, y };
}

/** Default dock: middle-lower area of the right edge (design.md §14.2). */
const DEFAULT_POS: DotPosition = { side: "right", y: 0.65 };

export function applyPosition(el: HTMLElement, pos: DotPosition | null): void {
  const p = pos ?? DEFAULT_POS;
  el.style.position = "fixed";
  el.style.zIndex = "2147483600";
  el.style.top = `${p.y * 100}vh`;
  el.style.left = p.side === "left" ? "8px" : "auto";
  el.style.right = p.side === "right" ? "8px" : "auto";
}
