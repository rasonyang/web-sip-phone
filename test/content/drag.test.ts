// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POS,
  applyPosition,
  clampPixels,
  normalizePosition,
  pixelsFromPosition,
  positionFromPixels
} from "../../src/content/drag.js";

// Viewport 1000×1000 with an 8px margin and a 36px widget leaves 948px of free travel per axis.
const W = 1000;
const H = 1000;

describe("positionFromPixels", () => {
  it("stores both axes as free-space fractions", () => {
    expect(positionFromPixels(8, 8, W, H)).toEqual({ x: 0, y: 0 });
    expect(positionFromPixels(956, 956, W, H)).toEqual({ x: 1, y: 1 });
    expect(positionFromPixels(482, 482, W, H)).toEqual({ x: 0.5, y: 0.5 });
  });
  it("clamps out-of-viewport drops", () => {
    expect(positionFromPixels(-500, -500, W, H)).toEqual({ x: 0, y: 0 });
    expect(positionFromPixels(5000, 5000, W, H)).toEqual({ x: 1, y: 1 });
  });
  it("round-trips through pixelsFromPosition", () => {
    const pos = positionFromPixels(300, 700, W, H);
    expect(pixelsFromPosition(pos, W, H)).toEqual({ left: 300, top: 700 });
  });
});

describe("pixelsFromPosition", () => {
  it("keeps a corner-parked widget in its corner across viewport sizes", () => {
    expect(pixelsFromPosition({ x: 1, y: 0 }, W, H)).toEqual({ left: 956, top: 8 });
    expect(pixelsFromPosition({ x: 1, y: 0 }, 500, 400)).toEqual({ left: 456, top: 8 });
  });
});

describe("clampPixels", () => {
  it("holds a drag inside the margins", () => {
    expect(clampPixels(-40, -40, W, H)).toEqual({ left: 8, top: 8 });
    expect(clampPixels(2000, 2000, W, H)).toEqual({ left: 956, top: 956 });
    expect(clampPixels(120, 640, W, H)).toEqual({ left: 120, top: 640 });
  });
});

describe("normalizePosition", () => {
  it("defaults to the top-right dock", () => {
    expect(normalizePosition(null)).toEqual({ x: 1, y: 0 });
    expect(DEFAULT_POS).toEqual({ x: 1, y: 0 });
  });
  it("migrates the legacy edge-docked shape", () => {
    expect(normalizePosition({ side: "right", y: 0.65 })).toEqual({ x: 1, y: 0.65 });
    expect(normalizePosition({ side: "left", y: 0.5 })).toEqual({ x: 0, y: 0.5 });
  });
  it("clamps stored fractions", () => {
    expect(normalizePosition({ x: 2, y: -1 })).toEqual({ x: 1, y: 0 });
  });
});

describe("applyPosition", () => {
  it("pins the widget by top/left with the other edges released", () => {
    const el = document.createElement("div");
    applyPosition(el, null, W, H);
    expect(el.style.position).toBe("fixed");
    expect(el.style.left).toBe("956px");
    expect(el.style.top).toBe("8px");
    expect(el.style.right).toBe("auto");
    expect(el.style.bottom).toBe("auto");
  });
  it("restores a saved free position", () => {
    const el = document.createElement("div");
    applyPosition(el, { x: 0.25, y: 0.75 }, W, H);
    expect(el.style.left).toBe("245px");
    expect(el.style.top).toBe("719px");
  });
});
