import { beforeEach, describe, expect, it } from "vitest";
import { installFakeChrome, type FakeChrome } from "../fakes/chrome.js";

let fake: FakeChrome;
beforeEach(() => {
  fake = installFakeChrome();
});

import { TabTracker } from "../../src/background/tab-tracker.js";

const SITES = ["crm.example.com"];

async function makeTracker(): Promise<{ tracker: TabTracker; changes: () => number }> {
  const tracker = new TabTracker(() => SITES);
  let n = 0;
  tracker.onChange(() => n++);
  await tracker.init();
  return { tracker, changes: () => n };
}

describe("TabTracker", () => {
  it("finds existing allow-site tabs on init (multiple windows are just more tabs)", async () => {
    fake._tabs.push({ id: 1, url: "https://crm.example.com/a" });
    fake._tabs.push({ id: 2, url: "https://other.example.com/" });
    fake._tabs.push({ id: 3, url: "https://crm.example.com/b" });
    const { tracker } = await makeTracker();
    expect(tracker.count()).toBe(2);
    expect(tracker.ids().sort()).toEqual([1, 3]);
  });

  it("tracks first tab opened and last tab closed", async () => {
    const { tracker, changes } = await makeTracker();
    expect(tracker.count()).toBe(0);
    fake._openTab(1, "https://crm.example.com/");
    expect(tracker.count()).toBe(1);
    expect(tracker.isLast(1)).toBe(true);
    fake._openTab(2, "https://crm.example.com/x");
    expect(tracker.isLast(1)).toBe(false);
    fake._closeTab(1); // intermediate close: still one left
    expect(tracker.count()).toBe(1);
    fake._closeTab(2);
    expect(tracker.count()).toBe(0);
    expect(changes()).toBeGreaterThanOrEqual(4);
  });

  it("navigation into and out of an allow site updates membership", async () => {
    const { tracker } = await makeTracker();
    fake._openTab(1, "https://other.example.com/");
    expect(tracker.count()).toBe(0);
    fake._navigateTab(1, "https://crm.example.com/");
    expect(tracker.count()).toBe(1);
    fake._navigateTab(1, "https://other.example.com/");
    expect(tracker.count()).toBe(0);
  });

  it("does not fire change for irrelevant tabs", async () => {
    const { changes } = await makeTracker();
    const before = changes();
    fake._openTab(9, "https://unrelated.example.com/");
    fake._closeTab(9);
    expect(changes()).toBe(before);
  });
});
