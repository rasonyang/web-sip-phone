import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome, type FakeChrome } from "../fakes/chrome.js";

let fake: FakeChrome;
beforeEach(() => {
  vi.resetModules();
  fake = installFakeChrome();
});

const ACCOUNT = { domain: "voice.example.com", username: "1001", password: "pw" };

function seedConfig(config: Record<string, unknown>) {
  const merged = { account: null, allowSites: [], turn: null, dotPosition: null, ...config } as Record<string, unknown>;
  fake._localData["websipphone.account"] = merged.account;
  fake._localData["websipphone.allowSites"] = merged.allowSites;
  fake._localData["websipphone.turn"] = merged.turn;
  fake._localData["websipphone.dotPosition"] = merged.dotPosition;
}

async function boot(config: Record<string, unknown>) {
  seedConfig(config);
  const mod = await import("../../src/background/service-worker.js");
  await mod.initServiceWorker();
  return mod;
}

function offscreenStatus(overrides: Record<string, unknown> = {}) {
  return {
    target: "background",
    type: "offscreen/status",
    status: {
      phase: "ready",
      errors: [],
      reconnecting: false,
      link: { registration: "up", websocket: "up", microphone: "ok", media: "idle" },
      callInProgress: false,
      ...overrides
    }
  };
}

describe("service worker lifecycle", () => {
  it("does not start the runtime with no allow-site tab", async () => {
    await boot({ account: ACCOUNT, allowSites: ["crm.example.com"] });
    expect(fake._offscreenOpen).toBe(false);
  });

  it("starts offscreen + runtime when the first allow-site tab opens", async () => {
    await boot({ account: ACCOUNT, allowSites: ["crm.example.com"] });
    fake._openTab(1, "https://crm.example.com/");
    await vi.waitFor(() => expect(fake._offscreenOpen).toBe(true));
    const start = fake.sentRuntimeMessages.find(
      (m) => (m as { type?: string }).type === "runtime/start"
    ) as { config: { sipUri: string; wssUrl: string } };
    expect(start.config.sipUri).toBe("sip:1001@voice.example.com");
    expect(start.config.wssUrl).toBe("wss://voice.example.com/");
  });

  it("only one runtime/start for multiple tabs", async () => {
    await boot({ account: ACCOUNT, allowSites: ["crm.example.com"] });
    fake._openTab(1, "https://crm.example.com/");
    fake._openTab(2, "https://crm.example.com/b");
    await vi.waitFor(() => expect(fake._offscreenOpen).toBe(true));
    const starts = fake.sentRuntimeMessages.filter((m) => (m as { type?: string }).type === "runtime/start");
    expect(starts.length).toBe(1);
  });

  it("stops the runtime when the last allow-site tab closes", async () => {
    await boot({ account: ACCOUNT, allowSites: ["crm.example.com"] });
    fake._openTab(1, "https://crm.example.com/");
    await vi.waitFor(() => expect(fake._offscreenOpen).toBe(true));
    fake._closeTab(1);
    await vi.waitFor(() => {
      expect(fake.sentRuntimeMessages.some((m) => (m as { type?: string }).type === "runtime/stop")).toBe(true);
      expect(fake._offscreenOpen).toBe(false);
    });
  });

  it("does not start when unconfigured", async () => {
    await boot({ account: null, allowSites: ["crm.example.com"] });
    fake._openTab(1, "https://crm.example.com/");
    await new Promise((r) => setTimeout(r, 10));
    expect(fake._offscreenOpen).toBe(false);
  });

  it("recovers the evaluate() chain after a rejected offscreen open", async () => {
    await boot({ account: ACCOUNT, allowSites: ["crm.example.com", "app.example.com"] });

    const originalCreateDocument = fake.offscreen.createDocument;
    let failed = false;
    fake.offscreen.createDocument = async (...args: unknown[]) => {
      if (!failed) {
        failed = true;
        throw new Error("simulated createDocument failure");
      }
      return (originalCreateDocument as (...a: unknown[]) => Promise<void>)(...args);
    };

    fake._openTab(1, "https://crm.example.com/");
    await vi.waitFor(() => expect(failed).toBe(true));
    expect(fake._offscreenOpen).toBe(false);

    fake._openTab(2, "https://app.example.com/");
    await vi.waitFor(() => expect(fake._offscreenOpen).toBe(true));
  });
});

describe("account change while running", () => {
  const runtimeTypes = () =>
    fake.sentRuntimeMessages.map((m) => (m as { type?: string }).type).filter((t) => t?.startsWith("runtime/"));

  async function bootAndStart() {
    await boot({ account: ACCOUNT, allowSites: ["crm.example.com"] });
    fake._openTab(1, "https://crm.example.com/");
    await vi.waitFor(() => expect(fake._offscreenOpen).toBe(true));
    fake.sentRuntimeMessages.length = 0;
  }

  it("restarts the runtime with the new credentials on save", async () => {
    await bootAndStart();
    seedConfig({ account: { ...ACCOUNT, username: "1002" }, allowSites: ["crm.example.com"] });
    fake.runtime.onMessage.fire({ target: "background", type: "config/changed" }, {}, () => {});
    await vi.waitFor(() => {
      expect(runtimeTypes()).toContain("runtime/stop");
      expect(runtimeTypes()).toContain("runtime/start");
    });
    const types = runtimeTypes();
    expect(types.indexOf("runtime/stop")).toBeLessThan(types.indexOf("runtime/start"));
    const start = fake.sentRuntimeMessages.find((m) => (m as { type?: string }).type === "runtime/start") as {
      config: { sipUri: string };
    };
    expect(start.config.sipUri).toBe("sip:1002@voice.example.com");
    // The offscreen document is reused, not torn down.
    expect(fake._offscreenOpen).toBe(true);
  });

  it("re-saving an unchanged account does not restart the runtime", async () => {
    await bootAndStart();
    seedConfig({ account: ACCOUNT, allowSites: ["crm.example.com"] });
    fake.runtime.onMessage.fire({ target: "background", type: "config/changed" }, {}, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(runtimeTypes()).toEqual([]);
  });

  it("defers the restart during a call and applies it when the call ends", async () => {
    await bootAndStart();
    fake.runtime.onMessage.fire(offscreenStatus({ callInProgress: true }), {}, () => {});
    await new Promise((r) => setTimeout(r, 10));
    seedConfig({ account: { ...ACCOUNT, password: "new-pw" }, allowSites: ["crm.example.com"] });
    fake.runtime.onMessage.fire({ target: "background", type: "config/changed" }, {}, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(runtimeTypes()).toEqual([]); // live call untouched
    fake.runtime.onMessage.fire(offscreenStatus({ callInProgress: false }), {}, () => {});
    await vi.waitFor(() => {
      expect(runtimeTypes()).toContain("runtime/stop");
      expect(runtimeTypes()).toContain("runtime/start");
    });
    const start = fake.sentRuntimeMessages.find((m) => (m as { type?: string }).type === "runtime/start") as {
      config: { password: string };
    };
    expect(start.config.password).toBe("new-pw");
  });
});

describe("broadcast", () => {
  it("sends per-tab state with guardUnload only on the last tab during a call", async () => {
    await boot({ account: ACCOUNT, allowSites: ["crm.example.com"] });
    fake._openTab(1, "https://crm.example.com/");
    await vi.waitFor(() => expect(fake._offscreenOpen).toBe(true));
    fake.sentTabMessages.length = 0;
    fake.runtime.onMessage.fire(offscreenStatus({ callInProgress: true }), {}, () => {});
    await vi.waitFor(() => expect(fake.sentTabMessages.length).toBeGreaterThan(0));
    const msg = fake.sentTabMessages.find((m) => m.tabId === 1)!.message as { guardUnload: boolean; state: { runtime: string } };
    expect(msg.guardUnload).toBe(true);
    expect(msg.state.runtime).toBe("READY");
  });

  it("ui/getState replies with current TabState", async () => {
    await boot({ account: ACCOUNT, allowSites: ["crm.example.com"] });
    fake._openTab(1, "https://crm.example.com/");
    await vi.waitFor(() => expect(fake._offscreenOpen).toBe(true));
    let reply: unknown;
    fake.runtime.onMessage.fire(
      { target: "background", type: "ui/getState" },
      { tab: { id: 1 } },
      (r: unknown) => (reply = r)
    );
    await vi.waitFor(() => expect(reply).toBeDefined());
    expect((reply as { state: { runtime: string } }).state.runtime).toBeDefined();
  });
});

describe("content script + install", () => {
  it("registers one dynamic content script per allow site on config change", async () => {
    await boot({ account: ACCOUNT, allowSites: [] });
    seedConfig({ account: ACCOUNT, allowSites: ["crm.example.com"] });
    fake.runtime.onMessage.fire({ target: "background", type: "config/changed" }, {}, () => {});
    await vi.waitFor(() => expect(fake.registeredScripts.length).toBe(1));
    expect(fake.registeredScripts[0]).toMatchObject({
      id: "web-sip-phone-crm.example.com",
      matches: ["https://crm.example.com/*"]
    });
  });

  it("opens options page on first install", async () => {
    await boot({});
    fake.runtime.onInstalled.fire({ reason: "install" });
    await vi.waitFor(() => expect(fake.optionsOpened).toBe(1));
  });
});
