import type { DotPosition, StoredDotPosition } from "../shared/config.js";

/** Gap kept between the widget and the viewport edges. */
export const EDGE_MARGIN = 8;
/** Widget footprint — the host box is exactly the dot button (see the `.wrap` rules in view.ts). */
export const WIDGET_SIZE = 36;

/** Default dock: the top-right corner, where the host application puts its voice button. */
export const DEFAULT_POS: DotPosition = { x: 1, y: 0 };

/**
 * Positions are stored as a fraction of the *free* space (0 = flush against the top/left margin,
 * 1 = flush against the bottom/right margin) rather than as pixels, so a widget parked in a corner
 * stays in that corner when the window is resized, and one parked mid-screen stays proportional.
 */
function freeSpan(viewport: number): number {
  return Math.max(1, viewport - WIDGET_SIZE - 2 * EDGE_MARGIN);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Accepts the pre-1.0.3 `{ side, y }` shape so upgrading does not lose the parked spot. */
export function normalizePosition(pos: StoredDotPosition | null | undefined): DotPosition {
  if (!pos) {
    return DEFAULT_POS;
  }
  if ("x" in pos && typeof pos.x === "number" && typeof pos.y === "number") {
    return { x: clamp01(pos.x), y: clamp01(pos.y) };
  }
  if ("side" in pos && typeof pos.y === "number") {
    return { x: pos.side === "left" ? 0 : 1, y: clamp01(pos.y) };
  }
  return DEFAULT_POS;
}

/** Viewport pixels (widget top-left) → stored fractions. */
export function positionFromPixels(
  left: number,
  top: number,
  viewportW: number,
  viewportH: number
): DotPosition {
  return {
    x: clamp01((left - EDGE_MARGIN) / freeSpan(viewportW)),
    y: clamp01((top - EDGE_MARGIN) / freeSpan(viewportH))
  };
}

/** Stored fractions → viewport pixels (widget top-left). */
export function pixelsFromPosition(
  pos: DotPosition,
  viewportW: number,
  viewportH: number
): { left: number; top: number } {
  return {
    left: EDGE_MARGIN + clamp01(pos.x) * freeSpan(viewportW),
    top: EDGE_MARGIN + clamp01(pos.y) * freeSpan(viewportH)
  };
}

/** Keeps a drag in progress fully on screen, margins included. */
export function clampPixels(
  left: number,
  top: number,
  viewportW: number,
  viewportH: number
): { left: number; top: number } {
  return {
    left: Math.min(Math.max(left, EDGE_MARGIN), EDGE_MARGIN + freeSpan(viewportW)),
    top: Math.min(Math.max(top, EDGE_MARGIN), EDGE_MARGIN + freeSpan(viewportH))
  };
}

export function applyPosition(
  el: HTMLElement,
  pos: StoredDotPosition | null,
  viewportW: number = window.innerWidth,
  viewportH: number = window.innerHeight
): void {
  const { left, top } = pixelsFromPosition(normalizePosition(pos), viewportW, viewportH);
  el.style.position = "fixed";
  el.style.zIndex = "2147483600";
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
}
