import { describe, expect, it } from "vitest";
import { snapToEdge } from "../../src/content/drag.js";

describe("snapToEdge", () => {
  it("snaps to the nearer horizontal edge", () => {
    expect(snapToEdge(100, 500, 1000, 1000).side).toBe("left");
    expect(snapToEdge(900, 500, 1000, 1000).side).toBe("right");
    expect(snapToEdge(500, 500, 1000, 1000).side).toBe("right"); // tie → right (default dock side)
  });
  it("stores y as a clamped fraction", () => {
    expect(snapToEdge(0, 500, 1000, 1000).y).toBe(0.5);
    expect(snapToEdge(0, 10, 1000, 1000).y).toBe(0.05);
    expect(snapToEdge(0, 990, 1000, 1000).y).toBe(0.95);
  });
});
