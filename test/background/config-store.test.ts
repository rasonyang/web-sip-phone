import { beforeEach, describe, expect, it } from "vitest";
import { installFakeChrome, type FakeChrome } from "../fakes/chrome.js";

let fake: FakeChrome;
beforeEach(() => {
  fake = installFakeChrome();
});

// Import after fake install so the module sees globalThis.chrome at call time.
import { clearAccount, loadConfig, saveConfig } from "../../src/background/config-store.js";

describe("config store", () => {
  it("returns defaults when empty", async () => {
    expect(await loadConfig()).toEqual({ account: null, allowSites: [], turn: null, dotPosition: null });
  });

  it("saves and merges patches", async () => {
    await saveConfig({ account: { domain: "d", username: "u", password: "p" } });
    await saveConfig({ allowSites: ["crm.example.com"] });
    const cfg = await loadConfig();
    expect(cfg.account?.username).toBe("u");
    expect(cfg.allowSites).toEqual(["crm.example.com"]);
  });

  it("clearAccount clears SIP account and TURN credentials, keeps sites", async () => {
    await saveConfig({
      account: { domain: "d", username: "u", password: "p" },
      turn: { enabled: true, url: "turn:t", username: "tu", credential: "tc" },
      allowSites: ["crm.example.com"]
    });
    const cfg = await clearAccount();
    expect(cfg.account).toBeNull();
    expect(cfg.turn).toBeNull();
    expect(cfg.allowSites).toEqual(["crm.example.com"]);
  });

  it("writes only the keys present in the patch", async () => {
    await saveConfig({ allowSites: ["crm.example.com"] });
    await saveConfig({ account: { domain: "d", username: "u", password: "p" } });
    expect(Object.keys(fake._localData).sort()).toEqual(["websipphone.account", "websipphone.allowSites"]);
  });

  it("saveConfig({account: null}) does not touch allowSites", async () => {
    await saveConfig({ allowSites: ["crm.example.com"] });
    await saveConfig({ account: null });
    expect(fake._localData["websipphone.allowSites"]).toEqual(["crm.example.com"]);
    const cfg = await loadConfig();
    expect(cfg.account).toBeNull();
    expect(cfg.allowSites).toEqual(["crm.example.com"]);
  });

  it("does not let a concurrent write from another context clobber an unrelated field", async () => {
    // Simulate two different JS contexts (options page + service worker) racing to save
    // different fields. With per-key writes each patch touches only its own key, so the
    // second write's storage read happening after the first's write is trivially safe:
    // neither can clobber the other's field.
    await Promise.all([
      saveConfig({ dotPosition: { x: 0.25, y: 0.5 } }),
      saveConfig({ turn: { enabled: true, url: "turn:t", username: "tu", credential: "tc" } })
    ]);
    const cfg = await loadConfig();
    expect(cfg.dotPosition).toEqual({ x: 0.25, y: 0.5 });
    expect(cfg.turn).toEqual({ enabled: true, url: "turn:t", username: "tu", credential: "tc" });
  });
});
