import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome, type FakeChrome } from "../fakes/chrome.js";
import type { DisplayState } from "../../src/shared/state.js";
import { toPageState } from "../../src/shared/page-protocol.js";

let fake: FakeChrome;
beforeEach(() => {
  vi.resetModules();
  fake = installFakeChrome();
});

const ACCOUNT = { domain: "voice.example.com", username: "1001", password: "pw" };

function seedConfig(config: Record<string, unknown>) {
  const merged = {
    account: null,
    allowSites: [],
    turn: null,
    dotPosition: null,
    manualOverride: false,
    ...config
  } as Record<string, unknown>;
  fake._localData["websipphone.account"] = merged.account;
  fake._localData["websipphone.allowSites"] = merged.allowSites;
  fake._localData["websipphone.turn"] = merged.turn;
  fake._localData["websipphone.dotPosition"] = merged.dotPosition;
  fake._localData["websipphone.manualOverride"] = merged.manualOverride;
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
      registrationExpiresAt: null,
      reconnect: null,
      micDeviceLabel: null,
      micLevel: null,
      lastError: null,
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
    ) as { config: { sipUri: string; serverUrl: string } };
    expect(start.config.sipUri).toBe("sip:1001@voice.example.com");
    expect(start.config.serverUrl).toBe("wss://voice.example.com/");
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

describe("page reload does not own the call", () => {
  const runtimeTypes = () =>
    fake.sentRuntimeMessages.map((m) => (m as { type?: string }).type).filter((t) => t?.startsWith("runtime/"));

  async function bootInCall() {
    await boot({ account: ACCOUNT, allowSites: ["crm.example.com"] });
    fake._openTab(1, "https://crm.example.com/");
    await vi.waitFor(() => expect(fake._offscreenOpen).toBe(true));
    fake.runtime.onMessage.fire(offscreenStatus({ callInProgress: true }), {}, () => {});
    await new Promise((r) => setTimeout(r, 10));
    fake.sentRuntimeMessages.length = 0;
  }

  it("refreshing the only Allow Site tab touches the runtime not at all", async () => {
    await bootInCall();
    fake._navigateTab(1, "https://crm.example.com/"); // F5: same URL reloads
    await new Promise((r) => setTimeout(r, 20));
    // No runtime/stop means no BYE; no runtime/start means no fresh REGISTER and no new INVITE
    // or WebRTC negotiation. The SIP session and its Call-ID are simply never touched.
    expect(runtimeTypes()).toEqual([]);
    expect(fake._offscreenOpen).toBe(true);
  });

  it("keeps the runtime alive with no Allow Site tabs while a call is active", async () => {
    await bootInCall();
    fake._closeTab(1); // the reload window, or a navigation away: allowTabCount drops to 0
    await new Promise((r) => setTimeout(r, 20));
    expect(runtimeTypes()).toEqual([]);
    expect(fake._offscreenOpen).toBe(true);

    fake._openTab(1, "https://crm.example.com/"); // the page comes back
    await new Promise((r) => setTimeout(r, 20));
    expect(runtimeTypes()).toEqual([]); // already running: not restarted
    expect(fake._offscreenOpen).toBe(true);
  });

  it("tears the runtime down once the call ends with no Allow Site tabs left", async () => {
    await bootInCall();
    fake._closeTab(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(runtimeTypes()).toEqual([]);
    fake.runtime.onMessage.fire(offscreenStatus({ callInProgress: false }), {}, () => {});
    await vi.waitFor(() => expect(runtimeTypes()).toContain("runtime/stop"));
    await vi.waitFor(() => expect(fake._offscreenOpen).toBe(false));
  });

  it("a reloaded tab gets the current state back from ui/getState", async () => {
    await bootInCall();
    let reply: unknown;
    fake.runtime.onMessage.fire({ target: "background", type: "ui/getState" }, { tab: { id: 1 } }, (r: unknown) => (reply = r));
    await vi.waitFor(() => expect(reply).toBeDefined());
    const ts = reply as { state: { runtime: string; busy: boolean } };
    expect(ts.state.runtime).toBe("READY");
    expect(ts.state.busy).toBe(true); // the existing call, shown to a content script that never saw it start
  });
});

describe("broadcast", () => {
  it("sends per-tab state to every Allow Site tab", async () => {
    await boot({ account: ACCOUNT, allowSites: ["crm.example.com"] });
    fake._openTab(1, "https://crm.example.com/");
    await vi.waitFor(() => expect(fake._offscreenOpen).toBe(true));
    fake.sentTabMessages.length = 0;
    fake.runtime.onMessage.fire(offscreenStatus({ callInProgress: true }), {}, () => {});
    await vi.waitFor(() => expect(fake.sentTabMessages.length).toBeGreaterThan(0));
    const msg = fake.sentTabMessages.find((m) => m.tabId === 1)!.message as { state: { runtime: string; busy: boolean } };
    expect(msg.state.runtime).toBe("READY");
    expect(msg.state.busy).toBe(true);
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

describe("status detail relay", () => {
  async function bootTwoTabs() {
    await boot({ account: ACCOUNT, allowSites: ["crm.example.com"], turn: { enabled: true, url: "turn:t", username: "u", credential: "c" } });
    fake._openTab(1, "https://crm.example.com/");
    fake._openTab(2, "https://crm.example.com/other");
    await vi.waitFor(() => expect(fake._offscreenOpen).toBe(true));
    fake.sentTabMessages.length = 0;
  }

  const stateFor = (tabId: number) =>
    (fake.sentTabMessages.filter((m) => m.tabId === tabId).pop()!.message as { state: DisplayState }).state;

  it("relays every new payload field to all allow-site tabs, in sync", async () => {
    await bootTwoTabs();
    fake.runtime.onMessage.fire(
      offscreenStatus({
        registrationExpiresAt: 1_770_000_600_000,
        reconnect: { attempt: 4, nextAttemptAt: 1_770_000_016_000 },
        micDeviceLabel: "Studio Mic",
        lastError: { code: "REGISTRATION_FAILED", reasonPhrase: "403 Forbidden" }
      }),
      {},
      () => {}
    );
    await vi.waitFor(() => expect(fake.sentTabMessages.filter((m) => m.tabId === 2).length).toBeGreaterThan(0));
    for (const tabId of [1, 2]) {
      const details = stateFor(tabId).details;
      expect(details.account).toBe("1001");
      expect(details.domain).toBe("voice.example.com");
      expect(details.turnConfigured).toBe(true);
      expect(details.registrationExpiresAt).toBe(1_770_000_600_000);
      expect(details.reconnect).toEqual({ attempt: 4, nextAttemptAt: 1_770_000_016_000 });
      expect(details.micDeviceLabel).toBe("Studio Mic");
      expect(details.lastError).toEqual({ code: "REGISTRATION_FAILED", reasonPhrase: "403 Forbidden" });
    }
    expect(stateFor(1)).toEqual(stateFor(2));
    // The password never reaches a page, whatever else does.
    expect(JSON.stringify(fake.sentTabMessages)).not.toContain(ACCOUNT.password);
  });

  it("runs microphone metering only while a panel is expanded, and never levels to a collapsed tab", async () => {
    await bootTwoTabs();
    const meterCalls = () =>
      fake.sentRuntimeMessages
        .filter((m) => (m as { type?: string }).type === "runtime/micMeter")
        .map((m) => (m as { on: boolean }).on);
    const levelMessages = () => fake.sentTabMessages.filter((m) => (m.message as { type?: string }).type === "mic/level");

    // Collapsed everywhere: a level tick reaches nobody.
    fake.runtime.onMessage.fire({ target: "background", type: "offscreen/micLevel", level: 0.5 }, {}, () => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(levelMessages()).toEqual([]);
    expect(meterCalls()).toEqual([]);

    // Tab 1 expands its panel → metering on, and only tab 1 gets levels.
    fake.runtime.onMessage.fire({ target: "background", type: "ui/panelState", open: true }, { tab: { id: 1 } }, () => {});
    await vi.waitFor(() => expect(meterCalls()).toEqual([true]));
    fake.runtime.onMessage.fire({ target: "background", type: "offscreen/micLevel", level: 0.5 }, {}, () => {});
    await vi.waitFor(() => expect(levelMessages().length).toBe(1));
    expect(levelMessages()[0].tabId).toBe(1);

    // Collapsing the last open panel switches metering back off.
    fake.runtime.onMessage.fire({ target: "background", type: "ui/panelState", open: false }, { tab: { id: 1 } }, () => {});
    await vi.waitFor(() => expect(meterCalls()).toEqual([true, false]));
  });

  it("stops metering when the tab showing the panel is closed", async () => {
    await bootTwoTabs();
    fake.runtime.onMessage.fire({ target: "background", type: "ui/panelState", open: true }, { tab: { id: 1 } }, () => {});
    await new Promise((r) => setTimeout(r, 10));
    fake._closeTab(1);
    await vi.waitFor(() => {
      const meter = fake.sentRuntimeMessages.filter((m) => (m as { type?: string }).type === "runtime/micMeter");
      expect(meter[meter.length - 1]).toMatchObject({ on: false });
    });
  });

  it("routes the panel's microphone test to the offscreen runtime", async () => {
    await bootTwoTabs();
    fake.sentRuntimeMessages.length = 0;
    fake.runtime.onMessage.fire({ target: "background", type: "ui/testMic" }, { tab: { id: 1 } }, () => {});
    await vi.waitFor(() =>
      expect(fake.sentRuntimeMessages.some((m) => (m as { type?: string }).type === "runtime/testMic")).toBe(true)
    );
  });

  it("restarts a runtime that stopped itself once the microphone gate clears", async () => {
    await bootTwoTabs();
    // Blocked at start: the runtime stops itself, so the worker must not keep believing it runs.
    fake.runtime.onMessage.fire(offscreenStatus({ phase: "stopped", errors: ["MICROPHONE_BLOCKED"] }), {}, () => {});
    await new Promise((r) => setTimeout(r, 10));
    fake.sentRuntimeMessages.length = 0;
    fake.runtime.onMessage.fire(offscreenStatus({ phase: "stopped", errors: [] }), {}, () => {});
    await vi.waitFor(() =>
      expect(fake.sentRuntimeMessages.some((m) => (m as { type?: string }).type === "runtime/start")).toBe(true)
    );
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

describe("host-page provisioning", () => {
  const PROV = {
    sipDomain: "voice.example.com",
    wssUrl: "wss://voice.example.com:7443/ws",
    account: "2001",
    a1Hash: "0123456789abcdef0123456789abcdef",
    expiresAt: Date.now() + 3_600_000
  };
  const SITE_SENDER = { tab: { id: 1, url: "https://crm.example.com/app" }, frameId: 0 };
  const SITE = "crm.example.com";

  /** Flush the promise chain evaluate() runs on; works under fake timers, unlike vi.waitFor. */
  async function settle(ticks = 40) {
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve();
    }
  }

  const runtimeTypes = () =>
    fake.sentRuntimeMessages.map((m) => (m as { type?: string }).type).filter((t) => t?.startsWith("runtime/"));
  const starts = () =>
    fake.sentRuntimeMessages.filter((m) => (m as { type?: string }).type === "runtime/start") as Array<{
      config: Record<string, unknown>;
    }>;
  const lastStart = () => starts()[starts().length - 1];

  function fire(msg: Record<string, unknown>, sender: unknown = SITE_SENDER, respond: (r?: unknown) => void = () => {}) {
    fake.runtime.onMessage.fire({ target: "background", ...msg }, sender, respond);
  }
  const provision = (credential: Record<string, unknown> = PROV, sender: unknown = SITE_SENDER) =>
    fire({ type: "page/provision", credential }, sender);
  const deprovision = (sender: unknown = SITE_SENDER) => fire({ type: "page/deprovision" }, sender);

  /** Boot with one open Allow Site tab; `account` null means no manual credential at all. */
  async function bootWithTab(account: Record<string, unknown> | null = null, extra: Record<string, unknown> = {}) {
    await boot({ account, allowSites: [SITE], ...extra });
    fake._openTab(1, "https://crm.example.com/app");
    if (account) {
      await vi.waitFor(() => expect(fake._offscreenOpen).toBe(true));
    } else {
      await new Promise((r) => setTimeout(r, 10));
    }
    fake.sentRuntimeMessages.length = 0;
  }

  it("1. provisions a credential the runtime starts with, and never writes it to local storage", async () => {
    await bootWithTab();
    provision();
    await vi.waitFor(() => expect(starts().length).toBe(1));

    const cfg = lastStart().config;
    expect(cfg.a1Hash).toBe(PROV.a1Hash);
    expect(cfg.credentialSource).toBe("provisioned");
    expect(cfg.sipUri).toBe("sip:2001@voice.example.com");
    expect(cfg.serverUrl).toBe(PROV.wssUrl); // verbatim: nothing derived from it
    expect("password" in cfg).toBe(false);

    expect(fake._sessionData["websipphone.provisioned"]).toMatchObject({
      ...PROV,
      origin: "https://crm.example.com"
    });
    // The one storage area the Options page reads must never learn a provisioned secret.
    expect(JSON.stringify(fake._localData)).not.toContain(PROV.a1Hash);
  });

  it("2. ignores page messages from an unallowed site, a subframe, or no tab at all", async () => {
    await bootWithTab();
    provision(PROV, { tab: { id: 2, url: "https://evil.example/" } });
    provision(PROV, { ...SITE_SENDER, frameId: 3 });
    provision(PROV, {});
    await new Promise((r) => setTimeout(r, 20));
    expect(runtimeTypes()).toEqual([]);
    expect(fake._sessionData["websipphone.provisioned"]).toBeUndefined();
  });

  it("3. a provisioned credential takes precedence over the manual account", async () => {
    await bootWithTab(ACCOUNT);
    fake.runtime.onMessage.fire(offscreenStatus(), {}, () => {});
    await new Promise((r) => setTimeout(r, 10));
    fake.sentRuntimeMessages.length = 0;

    provision();
    await vi.waitFor(() => expect(runtimeTypes()).toEqual(["runtime/stop", "runtime/start"]));
    expect(lastStart().config).toMatchObject({ sipUri: "sip:2001@voice.example.com", credentialSource: "provisioned" });
  });

  it("4. re-provisioning a different credential restarts; an identical one does not", async () => {
    await bootWithTab();
    provision();
    await vi.waitFor(() => expect(starts().length).toBe(1));

    provision({ ...PROV, account: "2002" });
    await vi.waitFor(() => expect(starts().length).toBe(2));
    expect(runtimeTypes()).toEqual(["runtime/start", "runtime/stop", "runtime/start"]);
    expect(lastStart().config.sipUri).toBe("sip:2002@voice.example.com");

    fake.sentRuntimeMessages.length = 0;
    provision({ ...PROV, account: "2002" });
    await new Promise((r) => setTimeout(r, 20));
    expect(runtimeTypes()).toEqual([]);
  });

  it("5. deprovisioning falls back to the manual account", async () => {
    await bootWithTab(ACCOUNT);
    provision();
    await vi.waitFor(() => expect(starts().length).toBe(1));
    fake.sentRuntimeMessages.length = 0;

    deprovision();
    await vi.waitFor(() => expect(runtimeTypes()).toEqual(["runtime/stop", "runtime/start"]));
    expect(lastStart().config).toMatchObject({ sipUri: "sip:1001@voice.example.com", credentialSource: "manual" });
    expect(lastStart().config.password).toBe(ACCOUNT.password);
    expect(fake._sessionData["websipphone.provisioned"]).toBeUndefined();
  });

  it("5b. deprovisioning with no manual account stops the runtime outright", async () => {
    await bootWithTab();
    provision();
    await vi.waitFor(() => expect(fake._offscreenOpen).toBe(true));
    fake.sentRuntimeMessages.length = 0;

    deprovision();
    await vi.waitFor(() => {
      expect(runtimeTypes()).toEqual(["runtime/stop"]);
      expect(fake._offscreenOpen).toBe(false);
    });
  });

  it("6. an expired credential is dropped, and one that arrives expired is never taken", async () => {
    await bootWithTab(ACCOUNT);
    vi.useFakeTimers();
    try {
      provision({ ...PROV, expiresAt: Date.now() + 5000 });
      await settle();
      expect(lastStart().config.credentialSource).toBe("provisioned");
      fake.sentRuntimeMessages.length = 0;

      await vi.advanceTimersByTimeAsync(5001);
      await settle();
      expect(fake._sessionData["websipphone.provisioned"]).toBeUndefined();
      expect(runtimeTypes()).toEqual(["runtime/stop", "runtime/start"]);
      expect(lastStart().config).toMatchObject({ sipUri: "sip:1001@voice.example.com", credentialSource: "manual" });

      fake.sentRuntimeMessages.length = 0;
      provision({ ...PROV, expiresAt: Date.now() - 1 });
      await settle();
      expect(runtimeTypes()).toEqual([]);
      expect(fake._sessionData["websipphone.provisioned"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("7. losing the last Allow Site tab clears the credential for good", async () => {
    await bootWithTab(ACCOUNT);
    provision();
    await vi.waitFor(() => expect(starts().length).toBe(1));
    fake.sentRuntimeMessages.length = 0;

    fake._closeTab(1);
    await vi.waitFor(() => {
      expect(fake._sessionData["websipphone.provisioned"]).toBeUndefined();
      expect(runtimeTypes()).toContain("runtime/stop");
    });

    fake.sentRuntimeMessages.length = 0;
    fake._openTab(1, "https://crm.example.com/app");
    await vi.waitFor(() => expect(starts().length).toBe(1));
    expect(lastStart().config).toMatchObject({ sipUri: "sip:1001@voice.example.com", credentialSource: "manual" });
  });

  it("8. a manual edit made while provisioned is deferred, not applied", async () => {
    await bootWithTab(ACCOUNT);
    provision();
    await vi.waitFor(() => expect(starts().length).toBe(1));
    fake.sentRuntimeMessages.length = 0;

    seedConfig({ account: { ...ACCOUNT, password: "new-pw" }, allowSites: [SITE] });
    fire({ type: "config/changed" }, {});
    await new Promise((r) => setTimeout(r, 20));
    expect(runtimeTypes()).toEqual([]); // the provisioned registration is untouched

    deprovision();
    await vi.waitFor(() => expect(starts().length).toBe(1));
    expect(lastStart().config.password).toBe("new-pw");
  });

  it("9. page/hello answers an allowed sender with the current tab state, and nobody else", async () => {
    await bootWithTab();
    provision();
    await vi.waitFor(() => expect(starts().length).toBe(1));

    let reply: unknown = "unset";
    fire({ type: "page/hello" }, SITE_SENDER, (r) => (reply = r));
    await vi.waitFor(() => expect(reply).not.toBe("unset"));
    const state = (reply as { state: DisplayState }).state;
    expect(state.details.credentialSource).toBe("PROVISIONED");
    expect(state.details.provisionedBy).toBe("https://crm.example.com");
    expect(state.details.account).toBe("2001");
    expect(state.details.domain).toBe("voice.example.com");

    let denied: unknown = "unset";
    fire({ type: "page/hello" }, { tab: { id: 2, url: "https://evil.example/" } }, (r) => (denied = r));
    await vi.waitFor(() => expect(denied).not.toBe("unset"));
    expect(denied).toBeUndefined();
  });

  it("10. the a1Hash never reaches a broadcast", async () => {
    await bootWithTab();
    provision();
    await vi.waitFor(() => expect(starts().length).toBe(1));
    fake.runtime.onMessage.fire(offscreenStatus(), {}, () => {});
    await vi.waitFor(() => expect(fake.sentTabMessages.length).toBeGreaterThan(0));
    expect(JSON.stringify(fake.sentTabMessages)).not.toContain(PROV.a1Hash);
  });

  it("11. a restarted worker comes back with the provisioned credential", async () => {
    // The worker is killed and revived under a tab that never went away, so the tab is already
    // there when init runs — exactly the case where the credential must survive.
    fake._openTab(1, "https://crm.example.com/app");
    fake._sessionData["websipphone.provisioned"] = { ...PROV, origin: "https://crm.example.com" };
    await boot({ account: ACCOUNT, allowSites: [SITE] });
    await vi.waitFor(() => expect(starts().length).toBe(1));
    expect(lastStart().config).toMatchObject({
      sipUri: "sip:2001@voice.example.com",
      credentialSource: "provisioned",
      a1Hash: PROV.a1Hash
    });
  });

  /** The most recent state broadcast to tab 1 — what a page would actually be looking at. */
  const lastTabState = () =>
    (fake.sentTabMessages.filter((m) => m.tabId === 1).pop()!.message as { state: DisplayState }).state;

  /** The most recent state broadcast to the Options page — what the provisioning banner reads. */
  const optionsStates = () =>
    fake.sentRuntimeMessages.filter(
      (m) => (m as { target?: string; type?: string }).target === "options" && (m as { type?: string }).type === "state/update"
    ) as Array<{ state: DisplayState }>;
  const lastOptionsState = () => optionsStates()[optionsStates().length - 1].state;

  it("12. identity describes the running registration, not the credential waiting behind it", async () => {
    await bootWithTab(ACCOUNT);
    fake.runtime.onMessage.fire(offscreenStatus({ callInProgress: true }), {}, () => {});
    await new Promise((r) => setTimeout(r, 10));
    fake.sentTabMessages.length = 0;
    fake.sentRuntimeMessages.length = 0;

    provision();
    await vi.waitFor(() => expect(fake.sentTabMessages.length).toBeGreaterThan(0));
    // The swap is deferred for the length of the call, so the UA is still registered as 1001.
    // Reporting the provisioned identity here would name a registration that does not exist.
    expect(runtimeTypes()).toEqual([]);
    const during = lastTabState();
    expect(during.details.credentialSource).toBe("MANUAL");
    expect(during.details.account).toBe("1001");
    // The provision-status fields answer the other question — what is *held* — so they name the
    // credential whose swap is still waiting on the call, while account/credentialSource above
    // keep describing the registration that actually exists.
    expect(during.details.provisionedBy).toBe("https://crm.example.com");
    expect(during.details.provisionStatus).toBe("ACTIVE");
    expect(during.details.provisionedAccount).toBe("2001");

    fake.sentTabMessages.length = 0;
    fake.runtime.onMessage.fire(offscreenStatus({ callInProgress: false }), {}, () => {});
    await vi.waitFor(() => expect(runtimeTypes()).toEqual(["runtime/stop", "runtime/start"]));
    await vi.waitFor(() => expect(lastTabState().details.credentialSource).toBe("PROVISIONED"));
    expect(lastTabState().details.account).toBe("2001");
    expect(lastTabState().details.provisionedBy).toBe("https://crm.example.com");
  });

  it("13. removing the provisioning site from Allow Sites revokes its credential", async () => {
    await boot({ account: ACCOUNT, allowSites: [SITE, "portal.example.com"] });
    fake._openTab(1, "https://crm.example.com/app");
    fake._openTab(2, "https://portal.example.com/");
    await vi.waitFor(() => expect(fake._offscreenOpen).toBe(true));
    provision();
    await vi.waitFor(() => expect(fake._sessionData["websipphone.provisioned"]).toBeDefined());
    fake.sentRuntimeMessages.length = 0;

    // Another Allow Site tab stays open, so the last-tab rule in evaluate() does not fire:
    // only the withdrawn permission can account for the credential going away.
    seedConfig({ account: ACCOUNT, allowSites: ["portal.example.com"] });
    fire({ type: "config/changed" }, {});
    await vi.waitFor(() => {
      expect(fake._sessionData["websipphone.provisioned"]).toBeUndefined();
      expect(lastStart()?.config).toMatchObject({ sipUri: "sip:1001@voice.example.com", credentialSource: "manual" });
    });
  });

  it("14. the sender gate takes the sending document's URL and a strict frame 0", async () => {
    await bootWithTab();
    provision(PROV, { tab: { id: 1, url: "https://crm.example.com/app" } }); // no frameId at all
    provision(PROV, { ...SITE_SENDER, url: "https://evil.example/embed" }); // document ≠ tab URL
    provision(PROV, { ...SITE_SENDER, documentLifecycle: "prerender" }); // never shown to anybody
    await new Promise((r) => setTimeout(r, 20));
    expect(runtimeTypes()).toEqual([]);
    expect(fake._sessionData["websipphone.provisioned"]).toBeUndefined();

    // The same message from a real main-frame document on an Allow Site is taken, and the
    // origin recorded is the document's own.
    provision(PROV, { frameId: 0, tab: { id: 1 }, url: "https://crm.example.com/other" });
    await vi.waitFor(() => expect(starts().length).toBe(1));
    expect(fake._sessionData["websipphone.provisioned"]).toMatchObject({ origin: "https://crm.example.com" });
  });

  it("15. a provision and a deprovision fired back-to-back settle consistently", async () => {
    await bootWithTab(ACCOUNT);
    fake.sentRuntimeMessages.length = 0;

    // Neither is awaited: without serialization the deprovision's clear and the provision's
    // write race, and memory and session storage can end up disagreeing.
    provision();
    deprovision();
    await new Promise((r) => setTimeout(r, 30));

    expect(fake._sessionData["websipphone.provisioned"]).toBeUndefined();
    expect(runtimeTypes()[runtimeTypes().length - 1]).toBe("runtime/start");
    expect(lastStart().config).toMatchObject({ sipUri: "sip:1001@voice.example.com", credentialSource: "manual" });
    expect(JSON.stringify(lastStart().config)).not.toContain(PROV.a1Hash);
  });

  it("16. a malformed account or realm is ignored even from an allowed sender", async () => {
    await bootWithTab();
    provision({ ...PROV, sipDomain: "bad host" });
    provision({ ...PROV, account: "20 01" });
    await new Promise((r) => setTimeout(r, 20));
    expect(runtimeTypes()).toEqual([]);
    expect(fake._sessionData["websipphone.provisioned"]).toBeUndefined();
  });

  it("17. a mic-blocked provisioned runtime reports MIC_UNAVAILABLE, and deprovision restores MANUAL", async () => {
    await bootWithTab(ACCOUNT);
    provision();
    await vi.waitFor(() => expect(starts().length).toBe(1));
    fake.sentTabMessages.length = 0;

    fake.runtime.onMessage.fire(
      offscreenStatus({
        phase: "stopped",
        errors: ["MICROPHONE_BLOCKED"],
        link: { registration: "down", websocket: "down", microphone: "blocked", media: "idle" },
        lastError: { code: "MICROPHONE_BLOCKED", reasonPhrase: "microphone unavailable" }
      }),
      {},
      () => {}
    );
    await vi.waitFor(() => expect(fake.sentTabMessages.length).toBeGreaterThan(0));
    expect(toPageState(lastTabState())).toMatchObject({
      registration: "UNREGISTERED",
      microphone: "DENIED",
      error: "MIC_UNAVAILABLE",
      credentialSource: "PROVISIONED",
      account: "2001"
    });

    fake.sentRuntimeMessages.length = 0;
    deprovision();
    await vi.waitFor(() => expect(runtimeTypes()).toEqual(["runtime/stop", "runtime/start"]));
    expect(lastStart().config).toMatchObject({ sipUri: "sip:1001@voice.example.com", credentialSource: "manual" });

    // The bookkeeping survived the mic-blocked stop: the next status is attributed to the
    // manual runtime that is now actually running.
    fake.sentTabMessages.length = 0;
    fake.runtime.onMessage.fire(offscreenStatus(), {}, () => {});
    await vi.waitFor(() => expect(fake.sentTabMessages.length).toBeGreaterThan(0));
    expect(toPageState(lastTabState())).toMatchObject({
      registration: "REGISTERED",
      credentialSource: "MANUAL",
      account: "1001"
    });
  });

  it("18. a far-future expiry re-arms the clamped timer instead of dropping the credential", async () => {
    await bootWithTab(ACCOUNT);
    vi.useFakeTimers();
    try {
      // setTimeout's delay is a signed 32-bit int, so this expiry cannot be armed in one go.
      provision({ ...PROV, expiresAt: Date.now() + 2 ** 31 + 60_000 });
      await settle();
      expect(fake._sessionData["websipphone.provisioned"]).toBeDefined();

      await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
      await settle();
      expect(fake._sessionData["websipphone.provisioned"]).toBeDefined(); // re-armed, not expired

      await vi.advanceTimersByTimeAsync(61_000);
      await settle();
      expect(fake._sessionData["websipphone.provisioned"]).toBeUndefined();
      expect(lastStart().config).toMatchObject({ sipUri: "sip:1001@voice.example.com", credentialSource: "manual" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("19. a manual override holds the provisioned credential without applying it", async () => {
    await bootWithTab(ACCOUNT, { manualOverride: true });
    fake.sentRuntimeMessages.length = 0;

    provision();
    await vi.waitFor(() => expect(fake._sessionData["websipphone.provisioned"]).toBeDefined());
    await new Promise((r) => setTimeout(r, 20));

    // Validated and stored, but the manual registration is left exactly as it was: the
    // fingerprint the runtime was started with has not changed.
    expect(runtimeTypes()).toEqual([]);
    const held = fake._sessionData["websipphone.provisioned"] as Record<string, unknown>;
    expect(held).toMatchObject({ ...PROV, origin: "https://crm.example.com" });
    expect(typeof held.receivedAt).toBe("number");
    expect(held.receivedAt as number).toBeGreaterThan(0);

    expect(lastOptionsState().details).toMatchObject({
      account: "1001",
      credentialSource: "MANUAL",
      provisionStatus: "OVERRIDDEN",
      provisionedAccount: "2001",
      provisionedDomain: "voice.example.com",
      provisionedBy: "https://crm.example.com",
      provisionLastSyncAt: held.receivedAt,
      provisionFault: null,
      manualOverride: true
    });
  });

  it("20. clearing the override swaps the registration to the credential already held", async () => {
    await bootWithTab(ACCOUNT, { manualOverride: true });
    provision();
    await vi.waitFor(() => expect(fake._sessionData["websipphone.provisioned"]).toBeDefined());
    fake.sentRuntimeMessages.length = 0;

    // "Clear override" is an ordinary config write plus config/changed — no provisioning
    // message of its own; the held credential simply wins the next fingerprint comparison.
    seedConfig({ account: ACCOUNT, allowSites: [SITE], manualOverride: false });
    fire({ type: "config/changed" }, {});

    await vi.waitFor(() => expect(runtimeTypes()).toEqual(["runtime/stop", "runtime/start"]));
    expect(lastStart().config).toMatchObject({ sipUri: "sip:2001@voice.example.com", credentialSource: "provisioned" });
    expect(lastOptionsState().details).toMatchObject({
      account: "2001",
      credentialSource: "PROVISIONED",
      provisionStatus: "ACTIVE",
      manualOverride: false
    });
  });

  it("21. saving a manual account while provisioned establishes the override", async () => {
    await bootWithTab(ACCOUNT);
    provision();
    await vi.waitFor(() => expect(starts().length).toBe(1));
    fake.sentRuntimeMessages.length = 0;

    seedConfig({ account: { ...ACCOUNT, username: "1002" }, allowSites: [SITE], manualOverride: true });
    fire({ type: "config/changed" }, {});

    await vi.waitFor(() => expect(runtimeTypes()).toEqual(["runtime/stop", "runtime/start"]));
    expect(lastStart().config).toMatchObject({ sipUri: "sip:1002@voice.example.com", credentialSource: "manual" });
    // The credential is not revoked by being overridden — it is still held, and still shown.
    expect(fake._sessionData["websipphone.provisioned"]).toBeDefined();
    expect(lastOptionsState().details).toMatchObject({
      account: "1002",
      credentialSource: "MANUAL",
      provisionStatus: "OVERRIDDEN",
      provisionedAccount: "2001",
      manualOverride: true
    });
  });

  it("22. a hello with nothing held faults once the grace window runs out", async () => {
    await bootWithTab();
    vi.useFakeTimers();
    try {
      fire({ type: "page/hello" });
      await settle();
      await vi.advanceTimersByTimeAsync(9_000);
      await settle();
      expect(optionsStates().every((m) => m.state.details.provisionFault === null)).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(lastOptionsState().details.provisionFault).toBe("NOT_RECEIVED");
      expect(lastOptionsState().details.provisionStatus).toBe("NONE");
    } finally {
      vi.useRealTimers();
    }
  });

  it("23. a provision inside the grace window faults not at all and records its sync time", async () => {
    await bootWithTab();
    vi.useFakeTimers();
    try {
      fire({ type: "page/hello" });
      await settle();
      await vi.advanceTimersByTimeAsync(5_000);
      const at = Date.now();
      provision({ ...PROV, expiresAt: at + 3_600_000 });
      await settle();
      expect(lastOptionsState().details).toMatchObject({
        provisionFault: null,
        provisionStatus: "ACTIVE",
        provisionLastSyncAt: at
      });

      // The window is closed, not merely satisfied: its deadline passing reports nothing.
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(lastOptionsState().details.provisionFault).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("24. a rejected provision faults as INVALID at once, and the next valid one clears it", async () => {
    await bootWithTab();
    provision({ ...PROV, a1Hash: "not-a-hash" });
    await vi.waitFor(() => expect(lastOptionsState().details.provisionFault).toBe("INVALID"));
    expect(runtimeTypes()).toEqual([]);
    expect(fake._sessionData["websipphone.provisioned"]).toBeUndefined();

    provision();
    await vi.waitFor(() => expect(starts().length).toBe(1));
    expect(lastOptionsState().details).toMatchObject({ provisionFault: null, provisionStatus: "ACTIVE" });
  });

  it("25. ui/resync clears the fault, tells every surface, and reopens the window", async () => {
    await bootWithTab();
    vi.useFakeTimers();
    try {
      fire({ type: "page/hello" });
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(lastOptionsState().details.provisionFault).toBe("NOT_RECEIVED");

      fake.sentTabMessages.length = 0;
      fake.sentRuntimeMessages.length = 0;
      fire({ type: "ui/resync" }, {});
      await settle();

      // Every Allow Site tab is told, so the content script republishes to its page, and the
      // Options page is told too — that is where the banner reads the fault from.
      expect(fake.sentTabMessages.filter((m) => m.tabId === 1).length).toBeGreaterThan(0);
      expect(lastTabState().details.provisionFault).toBeNull();
      expect(lastOptionsState().details.provisionFault).toBeNull();

      // A fresh window, judged from the re-sync: nothing arrives, so the fault comes back.
      await vi.advanceTimersByTimeAsync(9_999);
      await settle();
      expect(lastOptionsState().details.provisionFault).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(lastOptionsState().details.provisionFault).toBe("NOT_RECEIVED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("26. Sign Out drops the held credential along with the manual account", async () => {
    await bootWithTab(ACCOUNT);
    provision();
    await vi.waitFor(() => expect(starts().length).toBe(1));
    fake.sentRuntimeMessages.length = 0;

    // What clearAccount() writes, followed by the config/changed it already sends. The Allow
    // Site tab stays open, so the last-tab rule cannot account for the credential going away.
    seedConfig({ account: null, allowSites: [SITE], manualOverride: false });
    fire({ type: "config/changed" }, {});

    await vi.waitFor(() => {
      expect(fake._sessionData["websipphone.provisioned"]).toBeUndefined();
      expect(runtimeTypes()).toEqual(["runtime/stop"]);
      expect(fake._offscreenOpen).toBe(false);
    });
    expect(lastOptionsState().details).toMatchObject({
      credentialSource: "NONE",
      provisionStatus: "NONE",
      provisionedAccount: null,
      provisionFault: null,
      manualOverride: false
    });
  });

  it("27. no broadcast carries the a1Hash, held or applied", async () => {
    await bootWithTab(ACCOUNT, { manualOverride: true });
    provision();
    await vi.waitFor(() => expect(fake._sessionData["websipphone.provisioned"]).toBeDefined());
    fake.runtime.onMessage.fire(offscreenStatus(), {}, () => {});
    await vi.waitFor(() => expect(fake.sentTabMessages.length).toBeGreaterThan(0));

    // The overridden credential is reported in full detail except the one field that matters.
    expect(lastOptionsState().details.provisionedAccount).toBe("2001");
    const broadcasts = [...fake.sentTabMessages.map((m) => m.message), ...optionsStates()];
    expect(broadcasts.length).toBeGreaterThan(0);
    expect(JSON.stringify(broadcasts)).not.toContain(PROV.a1Hash);
  });
});
