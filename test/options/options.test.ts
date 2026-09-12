// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import PAGE from "../../static/options.html?raw";
import { installFakeChrome, type FakeChrome } from "../fakes/chrome.js";
import { EMPTY_DETAILS, IDLE_LINK, RuntimeState, type DisplayState, type StatusDetails } from "../../src/shared/state.js";

// The page's own <script type="module"> is dropped: the test imports the module itself.
const BODY = PAGE.slice(PAGE.indexOf("<body>") + "<body>".length, PAGE.indexOf("</body>")).replace(
  /<script[\s\S]*?<\/script>/g,
  ""
);

const SITES_KEY = "websipphone.allowSites";
const ACCOUNT_KEY = "websipphone.account";
const OVERRIDE_KEY = "websipphone.manualOverride";

let fake: FakeChrome;

function displayState(details: Partial<StatusDetails>, over: Partial<DisplayState> = {}): DisplayState {
  return {
    runtime: RuntimeState.Ready,
    error: null,
    reconnecting: false,
    busy: false,
    link: IDLE_LINK,
    details: { ...EMPTY_DETAILS, ...details },
    ...over
  };
}

const SYNC_AT = Date.UTC(2024, 0, 2, 10, 30, 15);

const ACTIVE: Partial<StatusDetails> = {
  credentialSource: "PROVISIONED",
  provisionStatus: "ACTIVE",
  provisionedBy: "https://crm.example.com",
  provisionedAccount: "2001",
  provisionedDomain: "voice.example.com",
  provisionLastSyncAt: SYNC_AT,
  account: "2001"
};

const OVERRIDDEN: Partial<StatusDetails> = {
  credentialSource: "MANUAL",
  provisionStatus: "OVERRIDDEN",
  provisionedBy: "https://crm.example.com",
  provisionedAccount: "2001",
  provisionedDomain: "voice.example.com",
  provisionLastSyncAt: SYNC_AT,
  manualOverride: true,
  account: "1001"
};

/** Push a display state in exactly the way the service worker broadcasts it. */
function broadcast(details: Partial<StatusDetails>, over: Partial<DisplayState> = {}): void {
  fake.runtime.onMessage.fire({ target: "options", type: "state/update", state: displayState(details, over) }, {}, () => {});
}

/** Open or close the disclosure the way a user click does. */
function toggleDisclosure(open: boolean): void {
  const el = $<HTMLDetailsElement>("acc-manual");
  el.open = open;
  el.dispatchEvent(new Event("toggle"));
}

async function flush(ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

/** Build the DOM, then import the module so its top-level init runs against it. */
async function load(url: string): Promise<void> {
  window.history.replaceState(null, "", url);
  document.body.innerHTML = BODY;
  const mod = await import("../../src/options/options.js");
  await mod.ready;
  await flush();
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const visible = (id: string): boolean => !$(id).hidden;

beforeEach(() => {
  vi.resetModules();
  fake = installFakeChrome();
  // jsdom has no layout, so scrollIntoView is missing entirely.
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/options.html");
});

describe("options deep link ?site=", () => {
  it("prefills the input and offers a one-click Allow button", async () => {
    await load("/options.html?site=crm.example.com");

    expect(visible("section-sites")).toBe(true);
    expect(visible("section-account")).toBe(false);
    expect($<HTMLInputElement>("site-input").value).toBe("crm.example.com");
    expect(visible("site-allow-deeplink")).toBe(true);
    expect($("site-allow-deeplink").textContent).toBe("Allow crm.example.com");
  });

  it("requests the host permission and saves the site when clicked", async () => {
    await load("/options.html?site=crm.example.com");

    $("site-allow-deeplink").click();
    // Chrome only honours permissions.request while the user gesture is still live, so the click
    // handler must reach it with no await in front: assert before yielding to the microtask queue.
    expect(fake.permissionRequests.length).toBe(1);
    await flush();

    expect(fake.permissionRequests).toContainEqual({ origins: ["https://crm.example.com/*"] });
    expect(fake._localData[SITES_KEY]).toEqual(["crm.example.com"]);
    expect(fake.sentRuntimeMessages).toContainEqual({ target: "background", type: "config/changed" });
    expect($("site-list").textContent).toContain("crm.example.com");
  });

  it("closes the tab it was opened in when a page opened it", async () => {
    fake._currentTab = { id: 7, url: "chrome-extension://fake-id/options.html", openerTabId: 3 };
    await load("/options.html?site=crm.example.com");

    $("site-allow-deeplink").click();
    await flush();

    expect(fake.removedTabs).toEqual([7]);
  });

  it("stays open and reports success when nothing opened it", async () => {
    await load("/options.html?site=crm.example.com");

    $("site-allow-deeplink").click();
    await flush();

    expect(fake.removedTabs).toEqual([]);
    expect(visible("site-allow-deeplink")).toBe(false);
    expect($("site-status").textContent).toBe("Allowed.");
  });

  it("saves nothing when Chrome refuses the permission", async () => {
    fake._grantPermissions = false;
    await load("/options.html?site=crm.example.com");

    $("site-allow-deeplink").click();
    await flush();

    expect($("site-error").textContent).toBe("Chrome permission was not granted.");
    expect(fake._localData[SITES_KEY]).toBeUndefined();
    expect(fake.removedTabs).toEqual([]);
  });

  it("reports an invalid hostname and offers no button", async () => {
    await load("/options.html?site=not%20a%20host");

    expect(visible("section-sites")).toBe(true);
    expect($("site-error").textContent).toBe("Enter a valid hostname.");
    expect(visible("site-allow-deeplink")).toBe(false);
  });

  it("reports a host that is already configured and offers no button", async () => {
    fake._localData[SITES_KEY] = ["crm.example.com"];
    await load("/options.html?site=crm.example.com");

    expect($("site-error").textContent).toBe("Already configured.");
    expect(visible("site-allow-deeplink")).toBe(false);
  });

  it("parseSiteDeepLink classifies absent, valid, invalid and configured links", async () => {
    await load("/options.html");
    const { parseSiteDeepLink } = await import("../../src/options/options.js");

    expect(parseSiteDeepLink("", [])).toEqual({ host: null, raw: "", error: null, alreadyConfigured: false });
    expect(parseSiteDeepLink("?site=crm.example.com", [])).toEqual({
      host: "crm.example.com",
      raw: "crm.example.com",
      error: null,
      alreadyConfigured: false
    });
    expect(parseSiteDeepLink("?site=https://crm.example.com", []).error).toBe(
      "Enter a hostname only — no https://, port, or path"
    );
    expect(parseSiteDeepLink("?site=crm.example.com", ["crm.example.com"]).alreadyConfigured).toBe(true);
  });
});

describe("options deep link #microphone", () => {
  it("opens Advanced at the microphone controls with the test button focused", async () => {
    await load("/options.html#microphone");

    expect(visible("section-advanced")).toBe(true);
    expect(document.activeElement).toBe($("mic-test"));
    expect($("microphone").scrollIntoView).toHaveBeenCalled();
  });

  it("reacts to a later hash change", async () => {
    await load("/options.html");
    expect(visible("section-advanced")).toBe(false);

    window.history.replaceState(null, "", "/options.html#microphone");
    window.dispatchEvent(new Event("hashchange"));

    expect(visible("section-advanced")).toBe(true);
    expect(document.activeElement).toBe($("mic-test"));
  });

  it("wins over the section requested through chrome.storage.session, and clears the key", async () => {
    fake._sessionData["websipphone.openSection"] = "account";
    await load("/options.html#microphone");

    expect(visible("section-advanced")).toBe(true);
    expect(fake._sessionData["websipphone.openSection"]).toBeUndefined();
  });
});

describe("account section — manual only (state A)", () => {
  it("renders today's layout with no banner and no disclosure", async () => {
    await load("/options.html");

    for (const id of ["acc-server", "acc-username", "acc-password", "acc-pw-toggle", "acc-save"]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(visible("acc-provisioned")).toBe(false);
    const disclosure = document.getElementById("acc-manual");
    expect(disclosure === null || (disclosure as HTMLElement).hidden).toBe(true);
    expect(visible("acc-status")).toBe(true);
    expect(visible("acc-signout")).toBe(true);
  });

  it("prefills the stored account and saves without setting an override", async () => {
    fake._localData[ACCOUNT_KEY] = { domain: "voice.example.com", username: "1001", password: "s3cret" };
    await load("/options.html");

    expect($<HTMLInputElement>("acc-server").value).toBe("voice.example.com");
    expect($<HTMLInputElement>("acc-username").value).toBe("1001");

    $<HTMLInputElement>("acc-password").value = "newpass";
    $("acc-save").click();
    await flush();

    expect(fake._localData[ACCOUNT_KEY]).toMatchObject({ username: "1001", password: "newpass" });
    expect(fake._localData[OVERRIDE_KEY]).toBeUndefined();
    expect(fake.sentRuntimeMessages).toContainEqual({ target: "background", type: "config/changed" });
  });

  it("asks the service worker for the current state on load", async () => {
    await load("/options.html");

    expect(fake.sentRuntimeMessages).toContainEqual({ target: "background", type: "ui/getState" });
  });
});

describe("account section — provisioned, active (state B)", () => {
  it("shows the banner and keeps every credential input out of the DOM", async () => {
    await load("/options.html");
    expect(visible("acc-provisioned")).toBe(false);

    broadcast(ACTIVE);

    expect(visible("acc-provisioned")).toBe(true);
    const text = $("acc-provisioned").textContent ?? "";
    expect(text).toContain("https://crm.example.com");
    expect(text).toContain("account 2001");
    expect(text).toContain(`last sync ${new Date(SYNC_AT).toLocaleTimeString()}`);
    expect(text).toMatch(/last sync .*\d/);
    expect($("acc-provisioned").classList.contains("warning")).toBe(false);

    expect(document.getElementById("acc-resync")).not.toBeNull();
    for (const id of ["acc-server", "acc-username", "acc-password", "acc-pw-toggle", "acc-save"]) {
      expect(document.getElementById(id)).toBeNull();
    }
    expect(visible("acc-manual")).toBe(true);
    expect($<HTMLDetailsElement>("acc-manual").open).toBe(false);
    expect(document.getElementById("acc-status")).not.toBeNull();
    expect(document.getElementById("acc-signout")).not.toBeNull();
  });

  it("omits the last-sync segment when nothing has synced yet", async () => {
    await load("/options.html");
    broadcast({ ...ACTIVE, provisionLastSyncAt: null });

    expect($("acc-provisioned").textContent).toContain("Provisioned by https://crm.example.com · account 2001");
    expect($("acc-provisioned").textContent).not.toContain("last sync");
  });

  it("sends ui/resync when Re-sync is clicked", async () => {
    await load("/options.html");
    broadcast(ACTIVE);

    $("acc-resync").click();
    await flush();

    expect(fake.sentRuntimeMessages).toContainEqual({ target: "background", type: "ui/resync" });
  });

  it("applies the TabState the service worker answers with", async () => {
    const tabState = { state: displayState(ACTIVE), pos: null };
    const sent = fake.sentRuntimeMessages;
    fake.runtime.sendMessage = async (message: unknown): Promise<unknown> => {
      sent.push(message);
      return (message as { type: string }).type === "ui/getState" ? tabState : undefined;
    };

    await load("/options.html");

    expect(visible("acc-provisioned")).toBe(true);
    expect($("acc-provisioned").textContent).toContain("Provisioned by https://crm.example.com · account 2001");
    expect(document.getElementById("acc-server")).toBeNull();
  });

  it("goes back to the manual layout when the provisioned credential is gone", async () => {
    await load("/options.html");
    broadcast(ACTIVE);
    expect(document.getElementById("acc-server")).toBeNull();

    broadcast({ credentialSource: "MANUAL", account: "1001" });

    expect(visible("acc-provisioned")).toBe(false);
    expect(document.getElementById("acc-server")).not.toBeNull();
    expect($("acc-manual").hidden).toBe(true);
  });
});

describe("account section — opening the disclosure", () => {
  it("renders the stored manual account, the override notice, and saves an override", async () => {
    fake._localData[ACCOUNT_KEY] = { domain: "pbx.internal", username: "1001", password: "s3cret" };
    await load("/options.html");
    broadcast(ACTIVE);
    expect(document.getElementById("acc-server")).toBeNull();

    toggleDisclosure(true);

    // Pre-filled with the STORED manual account, never with the provisioned one.
    expect($<HTMLInputElement>("acc-server").value).toBe("pbx.internal");
    expect($<HTMLInputElement>("acc-username").value).toBe("1001");
    expect($<HTMLInputElement>("acc-password").value).toBe("s3cret");
    expect(visible("acc-override-note")).toBe(true);
    expect($("acc-override-note").textContent).toBe(
      "Saving a manual account here overrides provisioning until you clear it."
    );

    $<HTMLInputElement>("acc-server").value = "voice.example.com";
    $<HTMLInputElement>("acc-username").value = "1002";
    $<HTMLInputElement>("acc-password").value = "other";
    $("acc-save").click();
    await flush();

    expect(fake._localData[ACCOUNT_KEY]).toMatchObject({
      domain: "voice.example.com",
      username: "1002",
      password: "other"
    });
    expect(fake._localData[OVERRIDE_KEY]).toBe(true);
    expect(fake.sentRuntimeMessages).toContainEqual({ target: "background", type: "config/changed" });
  });

  it("removes the inputs again when the disclosure is closed", async () => {
    await load("/options.html");
    broadcast(ACTIVE);

    toggleDisclosure(true);
    expect(document.getElementById("acc-server")).not.toBeNull();

    toggleDisclosure(false);
    expect(document.getElementById("acc-server")).toBeNull();
    expect(document.getElementById("acc-save")).toBeNull();
  });
});

describe("account section — provisioned, overridden (state C)", () => {
  it("warns, shows the held credential read-only, and expands the disclosure", async () => {
    await load("/options.html");
    broadcast(OVERRIDDEN);

    const banner = $("acc-provisioned");
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("Provisioning disabled by manual account");
    expect(banner.classList.contains("warning")).toBe(true);

    const held = banner.querySelector(".readonly-line")?.textContent ?? "";
    expect(held).toContain("2001");
    expect(held).toContain("voice.example.com");
    expect(held).toContain("https://crm.example.com");

    expect($<HTMLDetailsElement>("acc-manual").open).toBe(true);
    for (const id of ["acc-server", "acc-username", "acc-password"]) {
      const value = $<HTMLInputElement>(id).value;
      expect(value).toBe("");
      expect(value).not.toContain("2001");
    }
    expect(document.getElementById("acc-clear-override")).not.toBeNull();
  });

  it("clears the override without clearing the stored manual account", async () => {
    fake._localData[ACCOUNT_KEY] = { domain: "pbx.internal", username: "1001", password: "s3cret" };
    fake._localData[OVERRIDE_KEY] = true;
    await load("/options.html");
    broadcast(OVERRIDDEN);

    $("acc-clear-override").click();
    await flush();

    expect(fake._localData[OVERRIDE_KEY]).toBe(false);
    expect(fake._localData[ACCOUNT_KEY]).toMatchObject({ username: "1001" });
    expect(fake.sentRuntimeMessages).toContainEqual({ target: "background", type: "config/changed" });
  });
});

describe("account section — disclosure auto-expand", () => {
  const cases: Array<[string, Partial<StatusDetails>, Partial<DisplayState>, string]> = [
    [
      "provisionFault NOT_RECEIVED",
      { ...ACTIVE, provisionFault: "NOT_RECEIVED" },
      {},
      "No credential arrived from the page yet. Re-sync or configure manually."
    ],
    ["provisionFault INVALID", { ...ACTIVE, provisionFault: "INVALID" }, {}, "The page sent an unusable credential."],
    [
      "provisioned registration failure",
      ACTIVE,
      { runtime: RuntimeState.RegistrationFailed, error: "REGISTRATION_FAILED" as const },
      "Registration with the provisioned credential failed."
    ],
    [
      "manualOverride",
      OVERRIDDEN,
      {},
      "A manual account is overriding the provisioned credential."
    ]
  ];

  for (const [name, details, over, reason] of cases) {
    it(`expands with the warning style for ${name}`, async () => {
      await load("/options.html");
      broadcast(details, over);

      const disclosure = $<HTMLDetailsElement>("acc-manual");
      expect(disclosure.open).toBe(true);
      expect(disclosure.classList.contains("warning")).toBe(true);
      expect(disclosure.textContent).toContain(reason);
      expect(visible("acc-manual-warn")).toBe(true);
    });
  }

  it("stays collapsed and unstyled when nothing is wrong", async () => {
    await load("/options.html");
    broadcast(ACTIVE);

    const disclosure = $<HTMLDetailsElement>("acc-manual");
    expect(disclosure.open).toBe(false);
    expect(disclosure.classList.contains("warning")).toBe(false);
    expect(visible("acc-manual-warn")).toBe(false);
  });

  it("never auto-collapses a disclosure the user opened", async () => {
    await load("/options.html");
    broadcast(ACTIVE);

    toggleDisclosure(true);
    broadcast(ACTIVE);

    expect($<HTMLDetailsElement>("acc-manual").open).toBe(true);
    expect(document.getElementById("acc-server")).not.toBeNull();
  });

  it("opens a collapsed disclosure on a transition into a warning condition", async () => {
    await load("/options.html");
    broadcast(ACTIVE);
    expect($<HTMLDetailsElement>("acc-manual").open).toBe(false);

    broadcast({ ...ACTIVE, provisionFault: "NOT_RECEIVED" });

    expect($<HTMLDetailsElement>("acc-manual").open).toBe(true);
    expect(document.getElementById("acc-server")).not.toBeNull();
  });

  it("does not re-open a warning disclosure the user closed again", async () => {
    await load("/options.html");
    broadcast({ ...ACTIVE, provisionFault: "INVALID" });
    expect($<HTMLDetailsElement>("acc-manual").open).toBe(true);

    toggleDisclosure(false);
    broadcast({ ...ACTIVE, provisionFault: "INVALID" });

    expect($<HTMLDetailsElement>("acc-manual").open).toBe(false);
  });
});

describe("account section — status line is never hidden", () => {
  it("reports registration in the active and overridden states", async () => {
    await load("/options.html");

    broadcast(ACTIVE);
    expect($<HTMLDetailsElement>("acc-manual").open).toBe(false);
    expect($("acc-status").textContent).toBe("Registered");
    expect($("acc-status").hidden).toBe(false);

    broadcast(ACTIVE, { runtime: RuntimeState.RegistrationFailed, error: "REGISTRATION_FAILED" });
    expect($("acc-status").textContent).toBe("Registration failed — check the values above");
    expect($("acc-status").classList.contains("error")).toBe(true);

    broadcast(OVERRIDDEN);
    expect($("acc-status").textContent).toBe("Registered");
    expect($("acc-status").hidden).toBe(false);
  });

  it("clears the stored account and the override on Sign Out", async () => {
    fake._localData[ACCOUNT_KEY] = { domain: "pbx.internal", username: "1001", password: "s3cret" };
    fake._localData[OVERRIDE_KEY] = true;
    await load("/options.html");

    $("acc-signout").click();
    await flush();

    expect(fake._localData[ACCOUNT_KEY]).toBeNull();
    expect(fake._localData[OVERRIDE_KEY]).toBe(false);
    expect($<HTMLInputElement>("acc-server").value).toBe("");
    expect($("acc-status").textContent).toBe("Account and credentials cleared.");
    expect(fake.sentRuntimeMessages).toContainEqual({ target: "background", type: "config/changed" });
  });
});

describe("accountSectionView", () => {
  it("maps the state table to modes, banners and expansion", async () => {
    await load("/options.html");
    const { accountSectionView } = await import("../../src/options/options.js");

    expect(accountSectionView(displayState({}))).toEqual({
      mode: "MANUAL",
      warning: null,
      bannerText: "",
      expanded: false
    });

    expect(accountSectionView(displayState(ACTIVE))).toEqual({
      mode: "ACTIVE",
      warning: null,
      bannerText: `Provisioned by https://crm.example.com · account 2001 · last sync ${new Date(
        SYNC_AT
      ).toLocaleTimeString()}`,
      expanded: false
    });

    expect(accountSectionView(displayState({ ...ACTIVE, provisionLastSyncAt: null })).bannerText).toBe(
      "Provisioned by https://crm.example.com · account 2001"
    );

    expect(accountSectionView(displayState(OVERRIDDEN))).toEqual({
      mode: "OVERRIDDEN",
      warning: "A manual account is overriding the provisioned credential.",
      bannerText: "Provisioning disabled by manual account",
      expanded: true
    });

    expect(accountSectionView(displayState({ ...ACTIVE, provisionFault: "NOT_RECEIVED" }))).toMatchObject({
      warning: "No credential arrived from the page yet. Re-sync or configure manually.",
      expanded: true
    });
    expect(accountSectionView(displayState({ ...ACTIVE, provisionFault: "INVALID" }))).toMatchObject({
      warning: "The page sent an unusable credential.",
      expanded: true
    });
    expect(
      accountSectionView(displayState(ACTIVE, { runtime: RuntimeState.RegistrationFailed, error: "REGISTRATION_FAILED" }))
    ).toMatchObject({
      warning: "Registration with the provisioned credential failed.",
      expanded: true
    });
    // A manual registration failure is not the provisioned credential's fault.
    expect(
      accountSectionView(
        displayState(OVERRIDDEN, { runtime: RuntimeState.RegistrationFailed, error: "REGISTRATION_FAILED" })
      ).warning
    ).toBe("A manual account is overriding the provisioned credential.");
  });
});

describe("options framed", () => {
  it("renders nothing but a pointer to the extensions menu inside an iframe", async () => {
    const own = Object.getOwnPropertyDescriptor(window, "top");
    Object.defineProperty(window, "top", { value: {}, configurable: true });
    try {
      await load("/options.html");
    } finally {
      if (own) {
        Object.defineProperty(window, "top", own);
      } else {
        delete (window as unknown as Record<string, unknown>).top;
      }
    }

    for (const id of [
      "acc-server",
      "acc-username",
      "acc-password",
      "acc-save",
      "acc-manual",
      "acc-provisioned",
      "site-allow-deeplink",
      "site-add"
    ]) {
      expect(document.getElementById(id)).toBeNull();
    }
    expect(document.body.textContent).toBe("Open Web SIP Phone settings from the extensions menu.");
  });
});

describe("options live openSection write", () => {
  it("does not steal the section from a deep link the user has not acted on", async () => {
    await load("/options.html?site=crm.example.com");
    expect(visible("section-sites")).toBe(true);

    await fake.storage.session.set({ "websipphone.openSection": "advanced" });
    await flush();

    expect(visible("section-sites")).toBe(true);
    expect(visible("section-advanced")).toBe(false);

    $("site-allow-deeplink").click();
    await flush();

    // Acted on: the deep link no longer holds the section.
    await fake.storage.session.set({ "websipphone.openSection": "advanced" });
    await flush();

    expect(visible("section-advanced")).toBe(true);
    expect(visible("section-sites")).toBe(false);
  });
});
