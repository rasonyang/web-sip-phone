import { clearAccount, loadConfig, saveConfig } from "../background/config-store.js";
import type { AccountConfig } from "../shared/config.js";
import { isMsg, type TabState } from "../shared/messages.js";
import { EMPTY_DETAILS, IDLE_LINK, RuntimeState, type DisplayState } from "../shared/state.js";
import { allowSiteInputError, normalizeHostname, originPatterns } from "../shared/allow-sites.js";
import { parseServerAddress, serverWarningText } from "../shared/server-address.js";
import { MIC_CONSTRAINTS } from "../offscreen/media.js";

declare const __SIPJS_REF__: string;

const OPEN_SECTION_KEY = "websipphone.openSection";

/**
 * True while a deep link (`?site=` or `#microphone`) is showing its section and the user has not
 * acted on it yet. A live `openSection` write from another context must not pull the section out
 * from under a link the user was sent here to act on, so the storage listener stands down until
 * the Allow button has completed or the microphone test has been clicked.
 */
let deepLinkActive = false;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function setAccountStatus(text: string, isError = false): void {
  const el = $("acc-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

/** Non-error line under the Allow Sites input; the red `#site-error` stays for failures. */
function setSiteStatus(text: string): void {
  $("site-status").textContent = text;
}

function notifyConfigChanged(): void {
  void chrome.runtime.sendMessage({ target: "background", type: "config/changed" }).catch(() => {});
}

// ---- section switching ----
function showSection(name: string): void {
  for (const section of document.querySelectorAll("main section")) {
    (section as HTMLElement).hidden = section.id !== `section-${name}`;
  }
  for (const btn of document.querySelectorAll("nav button")) {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.section === name);
  }
}

/** Show the section requested via chrome.storage.session, then clear the key. */
function applyRequestedSection(section: string | undefined): void {
  if (section) {
    showSection(section);
    void chrome.storage.session.remove(OPEN_SECTION_KEY);
  }
}

function wireNav(): void {
  for (const btn of document.querySelectorAll("nav button")) {
    btn.addEventListener("click", () => showSection((btn as HTMLElement).dataset.section!));
  }
  // The options page may already be open when a tab's error action requests a section switch
  // (chrome.runtime.openOptionsPage only focuses an existing tab, it doesn't reload it), so also
  // react live to the storage write instead of only reading it once at load.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "session") return;
    if (deepLinkActive) return;
    const change = changes[OPEN_SECTION_KEY];
    if (change && "newValue" in change && change.newValue !== undefined) {
      applyRequestedSection(change.newValue as string);
    }
  });
}

// ---- account ----
/**
 * lucide-style inline SVG (24×24 viewBox, currentColor stroke). Hand-authored: the extension
 * ships no icon library. The static ones (chevron-right, triangle-alert on the summary) live in
 * options.html; these two are needed by nodes options.ts builds itself.
 */
const ICON_REFRESH_CW =
  '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />' +
  '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M3 21v-5h5" /></svg>';

const ICON_TRIANGLE_ALERT =
  '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />' +
  '<path d="M12 9v4" /><path d="M12 17h.01" /></svg>';

/** Parse a static icon string into nodes without ever touching innerHTML on a live element. */
function icon(markup: string): DocumentFragment {
  const holder = document.createElement("template");
  holder.innerHTML = markup;
  return holder.content;
}

/** The latest broadcast state; the account section is a pure function of it plus the config. */
let latestState: DisplayState = {
  runtime: RuntimeState.Unconfigured,
  error: null,
  reconnecting: false,
  busy: false,
  link: IDLE_LINK,
  details: EMPTY_DETAILS
};

/** The stored manual account. Provisioned values are never written into an editable input. */
let storedAccount: AccountConfig | null = null;

/**
 * The user opened or closed the disclosure by hand. While set, no state update re-opens it; it is
 * reset once the state leaves every warning condition. The disclosure is never auto-collapsed.
 */
let userToggled = false;
/** The last `open` value this module applied, so the toggle event can tell a user act apart. */
let lastAppliedOpen = false;

export interface AccountSectionView {
  mode: "MANUAL" | "ACTIVE" | "OVERRIDDEN";
  /** Reason line for the warning variant of the disclosure; null when there is nothing wrong. */
  warning: string | null;
  bannerText: string;
  expanded: boolean;
}

function localTime(at: number): string {
  return new Date(at).toLocaleTimeString();
}

/**
 * Pure view model for the Account section, so the state table can be tested without a DOM.
 * Mirrors design.md §5.1 "Account section states" and its auto-expand list.
 */
export function accountSectionView(state: DisplayState): AccountSectionView {
  const d = state.details;
  const mode =
    d.provisionStatus === "ACTIVE" ? "ACTIVE" : d.provisionStatus === "OVERRIDDEN" ? "OVERRIDDEN" : "MANUAL";

  if (mode === "MANUAL") {
    // No disclosure exists in the manual-only state, so it has neither warning nor banner.
    return { mode, warning: null, bannerText: "", expanded: false };
  }

  const warning =
    d.provisionFault === "NOT_RECEIVED"
      ? "No credential arrived from the page yet. Re-sync or configure manually."
      : d.provisionFault === "INVALID"
        ? "The page sent an unusable credential."
        : d.credentialSource === "PROVISIONED" && state.error === "REGISTRATION_FAILED"
          ? "Registration with the provisioned credential failed."
          : d.manualOverride
            ? "A manual account is overriding the provisioned credential."
            : null;

  if (mode === "OVERRIDDEN") {
    return { mode, warning, bannerText: "Provisioning disabled by manual account", expanded: true };
  }

  const sync = d.provisionLastSyncAt === null ? "" : ` · last sync ${localTime(d.provisionLastSyncAt)}`;
  return {
    mode,
    warning,
    bannerText: `Provisioned by ${d.provisionedBy} · account ${d.provisionedAccount}${sync}`,
    expanded: warning !== null
  };
}

function setupPasswordToggle(inputId: string, toggleId: string): void {
  $(toggleId).addEventListener("click", () => {
    const input = $<HTMLInputElement>(inputId);
    input.type = input.type === "password" ? "text" : "password";
  });
}

/** Mirror the plaintext / mixed-content warning for whatever is currently typed in Server. */
function updateServerWarning(): void {
  const el = document.getElementById("acc-server-warning");
  const server = document.getElementById("acc-server") as HTMLInputElement | null;
  if (!el || !server) {
    return;
  }
  const text = serverWarningText(parseServerAddress(server.value), location.protocol);
  el.textContent = text ?? "";
  el.hidden = text === null;
}

function fillManualForm(): void {
  const server = document.getElementById("acc-server") as HTMLInputElement | null;
  if (!server) {
    return;
  }
  // Pre-merge configs may carry only a domain; it is a valid Server value on its own.
  server.value = storedAccount ? (storedAccount.serverUrl ?? storedAccount.domain) : "";
  $<HTMLInputElement>("acc-username").value = storedAccount?.username ?? "";
  $<HTMLInputElement>("acc-password").value = storedAccount?.password ?? "";
  updateServerWarning();
}

function saveManualAccount(): void {
  void (async () => {
    const parsed = parseServerAddress($<HTMLInputElement>("acc-server").value);
    if (!parsed.ok) {
      setAccountStatus(parsed.error, true);
      return;
    }
    const username = $<HTMLInputElement>("acc-username").value.trim();
    const password = $<HTMLInputElement>("acc-password").value;
    if (!(username && password)) {
      setAccountStatus("Fill in Server, Account, and Password, or use Sign Out to clear the account.", true);
      return;
    }
    const account: AccountConfig = { domain: parsed.domain, username, password, serverUrl: parsed.serverUrl };
    // Saving while a provisioned credential is held establishes the override (design.md §5.1).
    const provisioned = accountSectionView(latestState).mode !== "MANUAL";
    storedAccount = account;
    await saveConfig(provisioned ? { account, manualOverride: true } : { account });
    setAccountStatus(
      provisioned
        ? "Saved. This manual account now overrides provisioning."
        : "Saved. Web SIP Phone connects when an Allow Site page is open."
    );
    notifyConfigChanged();
  })();
}

/** Wire the freshly cloned copy of the manual form; the nodes are new on every render. */
function wireManualForm(): void {
  setupPasswordToggle("acc-password", "acc-pw-toggle");
  $("acc-server").addEventListener("input", updateServerWarning);
  $("acc-save").addEventListener("click", saveManualAccount);
}

/** Clone the manual form into `container` if it is not already there, and mark its context. */
function ensureManualForm(container: HTMLElement, inDisclosure: boolean): void {
  if (container.childElementCount === 0) {
    const template = document.getElementById("acc-manual-form") as HTMLTemplateElement | null;
    if (!template) {
      return;
    }
    container.appendChild(template.content.cloneNode(true));
    wireManualForm();
    fillManualForm();
  }
  const note = document.getElementById("acc-override-note");
  if (note) {
    note.hidden = !inDisclosure;
  }
}

function setDisclosureOpen(el: HTMLDetailsElement, open: boolean): void {
  lastAppliedOpen = open;
  if (el.open !== open) {
    el.open = open;
  }
}

/** The credential inputs exist only while the disclosure is open (design.md §5.1). */
function renderDisclosureBody(): void {
  const disclosure = document.getElementById("acc-manual") as HTMLDetailsElement | null;
  const body = document.getElementById("acc-manual-body");
  if (!disclosure || !body) {
    return;
  }
  if (disclosure.hidden || !disclosure.open) {
    body.replaceChildren();
    return;
  }
  ensureManualForm(body, true);
}

function resyncButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = "acc-resync";
  button.type = "button";
  button.appendChild(icon(ICON_REFRESH_CW));
  button.appendChild(document.createTextNode("Re-sync"));
  button.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ target: "background", type: "ui/resync" }).catch(() => {});
  });
  return button;
}

function renderBanner(banner: HTMLElement, view: AccountSectionView): void {
  if (view.mode === "MANUAL") {
    banner.replaceChildren();
    banner.classList.remove("warning");
    banner.hidden = true;
    return;
  }
  const d = latestState.details;
  const nodes: Node[] = [];
  if (view.mode === "OVERRIDDEN") {
    nodes.push(icon(ICON_TRIANGLE_ALERT));
  }
  const body = document.createElement("div");
  body.className = "banner-body";
  const text = document.createElement("span");
  text.className = "banner-text";
  text.textContent = view.bannerText;
  body.appendChild(text);
  if (view.mode === "OVERRIDDEN") {
    // Read-only text, never an input value: provisioned credentials stay out of the form.
    const held = document.createElement("span");
    held.className = "readonly-line";
    held.textContent = `Held: account ${d.provisionedAccount} @ ${d.provisionedDomain} from ${d.provisionedBy}`;
    body.appendChild(held);
  }
  nodes.push(body, resyncButton());
  banner.replaceChildren(...nodes);
  banner.classList.toggle("warning", view.mode === "OVERRIDDEN");
  banner.hidden = false;
}

function renderClearOverride(actions: HTMLElement, view: AccountSectionView): void {
  if (view.mode !== "OVERRIDDEN") {
    actions.replaceChildren();
    return;
  }
  if (document.getElementById("acc-clear-override")) {
    return;
  }
  const button = document.createElement("button");
  button.id = "acc-clear-override";
  button.type = "button";
  button.textContent = "Clear override";
  button.addEventListener("click", () => {
    void (async () => {
      // The manual account stays stored; only the flag that applies it is dropped.
      await saveConfig({ manualOverride: false });
      setAccountStatus("Override cleared. The provisioned credential applies again.");
      notifyConfigChanged();
    })();
  });
  actions.replaceChildren(button);
}

/** Apply the account state table to the DOM. Idempotent: safe to run on every state update. */
function renderAccountSection(): void {
  const banner = document.getElementById("acc-provisioned");
  const disclosure = document.getElementById("acc-manual") as HTMLDetailsElement | null;
  const host = document.getElementById("acc-manual-host");
  if (!banner || !disclosure || !host) {
    return;
  }
  const view = accountSectionView(latestState);

  renderBanner(banner, view);

  disclosure.hidden = view.mode === "MANUAL";
  disclosure.classList.toggle("warning", view.warning !== null);
  const warn = document.getElementById("acc-manual-warn");
  const reason = document.getElementById("acc-manual-reason");
  if (warn && reason) {
    reason.textContent = view.warning ?? "";
    warn.hidden = view.warning === null;
  }

  if (view.warning === null) {
    userToggled = false;
  }
  if (view.mode === "MANUAL") {
    setDisclosureOpen(disclosure, false);
  } else if (view.expanded && !userToggled && !disclosure.open) {
    setDisclosureOpen(disclosure, true);
  }

  if (view.mode === "MANUAL") {
    document.getElementById("acc-manual-body")?.replaceChildren();
    ensureManualForm(host, false);
  } else {
    host.replaceChildren();
    renderDisclosureBody();
  }

  const actions = document.getElementById("acc-manual-actions");
  if (actions) {
    renderClearOverride(actions, view);
  }
}

async function initAccount(): Promise<void> {
  const cfg = await loadConfig();
  storedAccount = cfg.account;
  renderAccountSection();
}

/**
 * Apply a broadcast display state: the registration status line — which is never hidden by the
 * disclosure — plus the provisioning banner and the manual-credential disclosure.
 */
export function applyDisplayState(state: DisplayState): void {
  latestState = state;
  const runtime = state.runtime;
  const text =
    runtime === RuntimeState.Ready
      ? "Registered"
      : runtime === RuntimeState.RegistrationFailed
        ? "Registration failed — check the values above"
        : runtime === RuntimeState.InactiveNoAllowedSite
          ? "Idle (no Allow Site page open)"
          : runtime === RuntimeState.Unconfigured
            ? ""
            : runtime.toLowerCase();
  setAccountStatus(text, runtime === RuntimeState.RegistrationFailed);
  renderAccountSection();
}

function wireAccount(): void {
  const disclosure = $<HTMLDetailsElement>("acc-manual");
  disclosure.addEventListener("toggle", () => {
    // A change this module did not apply came from the user: stop auto-opening until the state
    // leaves every warning condition.
    if (disclosure.open !== lastAppliedOpen) {
      userToggled = true;
      lastAppliedOpen = disclosure.open;
    }
    renderDisclosureBody();
  });

  $("acc-signout").addEventListener("click", () => {
    void (async () => {
      await clearAccount();
      storedAccount = null;
      fillManualForm();
      setAccountStatus("Account and credentials cleared.");
      notifyConfigChanged();
    })();
  });

  // Registration status indicator: reuse the broadcast display state.
  chrome.runtime.onMessage.addListener((raw) => {
    if (isMsg(raw) && raw.target === "options" && raw.type === "state/update") {
      applyDisplayState(raw.state);
    }
    return false;
  });
}

// ---- allow sites ----
let siteMutation: Promise<void> = Promise.resolve();
function mutateSites(fn: (sites: string[]) => string[] | null): Promise<void> {
  const run = siteMutation.then(async () => {
    const cfg = await loadConfig();
    const next = fn(cfg.allowSites);
    if (next === null) {
      return;
    }
    await saveConfig({ allowSites: next });
    notifyConfigChanged();
  });
  // Keep the queue alive after failures; callers observe `run` for the real outcome.
  siteMutation = run.catch(() => {});
  return run;
}

async function renderSites(): Promise<void> {
  const cfg = await loadConfig();
  const list = $("site-list");
  list.replaceChildren();
  for (const host of cfg.allowSites) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = host;
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      void (async () => {
        try {
          await mutateSites((sites) => sites.filter((h) => h !== host));
        } catch {
          $("site-error").textContent = "Could not remove the site. Please try again.";
          return;
        }
        // Revoke where possible; failure is non-fatal (design.md §5.2).
        await chrome.permissions.remove({ origins: originPatterns(host) }).catch(() => {});
        await renderSites();
      })();
    });
    li.append(span, remove);
    list.appendChild(li);
  }
}

/**
 * Request the host permission and persist the site. `host` must already be normalized and known
 * not to be configured, so the permission request is the first await a click handler performs and
 * Chrome still sees the user gesture.
 */
async function addSite(host: string): Promise<boolean> {
  const granted = await chrome.permissions.request({ origins: originPatterns(host) });
  if (!granted) {
    $("site-error").textContent = "Chrome permission was not granted.";
    return false;
  }
  try {
    await mutateSites((sites) => (sites.includes(host) ? null : [...sites, host]));
  } catch {
    await chrome.permissions.remove({ origins: originPatterns(host) }).catch(() => {});
    $("site-error").textContent = "Could not save the site. Please try again.";
    return false;
  }
  await renderSites();
  return true;
}

export interface SiteDeepLink {
  /** Normalized hostname, or null when `?site=` is absent or not a hostname. */
  host: string | null;
  /** The raw query value, mirrored into the input so the user sees what was asked for. */
  raw: string;
  /** Message for `#site-error`; null when the link is actionable or absent. */
  error: string | null;
  alreadyConfigured: boolean;
}

/** Parse `options.html?site=<hostname>` against the current Allow Sites list. */
export function parseSiteDeepLink(search: string, allowSites: string[]): SiteDeepLink {
  const value = new URLSearchParams(search).get("site");
  if (value === null) {
    return { host: null, raw: "", error: null, alreadyConfigured: false };
  }
  const host = normalizeHostname(value);
  if (!host) {
    return { host: null, raw: value, error: allowSiteInputError(value), alreadyConfigured: false };
  }
  if (allowSites.includes(host)) {
    return { host, raw: value, error: "Already configured.", alreadyConfigured: true };
  }
  return { host, raw: value, error: null, alreadyConfigured: false };
}

function applySiteDeepLink(link: SiteDeepLink): void {
  showSection("sites");
  $<HTMLInputElement>("site-input").value = link.raw;
  const button = $<HTMLButtonElement>("site-allow-deeplink");
  if (link.error !== null || link.host === null) {
    $("site-error").textContent = link.error;
    button.hidden = true;
    return;
  }
  button.dataset.host = link.host;
  button.textContent = `Allow ${link.host}`;
  button.hidden = false;
}

/** A page-opened Options tab closes itself once the site is allowed; a hand-opened one stays. */
async function closeIfOpenedByPage(): Promise<void> {
  const tab = await Promise.resolve(chrome.tabs.getCurrent()).catch(() => undefined);
  // `!= null` rather than `!== null`: an absent opener is null in Chrome but undefined elsewhere.
  if (window.opener != null || tab?.openerTabId !== undefined) {
    if (tab?.id !== undefined) {
      await Promise.resolve(chrome.tabs.remove(tab.id)).catch(() => {});
    } else {
      window.close();
    }
    return;
  }
  setSiteStatus("Allowed.");
}

function wireSites(): void {
  $("site-add").addEventListener("click", () => {
    void (async () => {
      $("site-error").textContent = "";
      setSiteStatus("");
      const raw = $<HTMLInputElement>("site-input").value;
      const host = normalizeHostname(raw);
      if (!host) {
        $("site-error").textContent = allowSiteInputError(raw);
        return;
      }
      const cfg = await loadConfig();
      if (cfg.allowSites.includes(host)) {
        $("site-error").textContent = "Already configured.";
        return;
      }
      if (await addSite(host)) {
        $<HTMLInputElement>("site-input").value = "";
      }
    })();
  });

  $("site-allow-deeplink").addEventListener("click", () => {
    const button = $<HTMLButtonElement>("site-allow-deeplink");
    const host = button.dataset.host;
    if (!host) {
      return;
    }
    $("site-error").textContent = "";
    setSiteStatus("");
    void (async () => {
      if (!(await addSite(host))) {
        return;
      }
      deepLinkActive = false;
      button.hidden = true;
      await closeIfOpenedByPage();
    })();
  });
}

// ---- advanced: microphone ----
/** Apply `options.html#microphone`: open Advanced at the microphone controls, ready to test. */
function applyMicrophoneHash(): boolean {
  if (location.hash !== "#microphone") {
    return false;
  }
  showSection("advanced");
  document.getElementById("microphone")?.scrollIntoView();
  $<HTMLButtonElement>("mic-test").focus();
  return true;
}

function wireAdvanced(): void {
  window.addEventListener("hashchange", () => {
    applyMicrophoneHash();
  });

  $("mic-test").addEventListener("click", () => {
    deepLinkActive = false;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        stream.getTracks().forEach((t) => t.stop());
        $("mic-status").textContent = "Microphone OK.";
        notifyConfigChanged(); // runtime may now pass its mic gate
      } catch {
        $("mic-status").textContent =
          "Microphone blocked. Click the mic icon in the address bar or check chrome://settings/content/microphone, then test again.";
      }
    })();
  });

  // ---- advanced: TURN ----
  setupPasswordToggle("turn-credential", "turn-cred-toggle");

  $("turn-save").addEventListener("click", () => {
    void (async () => {
      await saveConfig({
        turn: {
          enabled: $<HTMLInputElement>("turn-enabled").checked,
          url: $<HTMLInputElement>("turn-url").value.trim(),
          username: $<HTMLInputElement>("turn-username").value.trim(),
          credential: $<HTMLInputElement>("turn-credential").value
        }
      });
      notifyConfigChanged();
    })();
  });
}

async function initTurn(): Promise<void> {
  const cfg = await loadConfig();
  if (cfg.turn) {
    $<HTMLInputElement>("turn-enabled").checked = cfg.turn.enabled;
    $<HTMLInputElement>("turn-url").value = cfg.turn.url;
    $<HTMLInputElement>("turn-username").value = cfg.turn.username;
    $<HTMLInputElement>("turn-credential").value = cfg.turn.credential;
  }
}

function isTabState(value: unknown): value is TabState {
  return typeof value === "object" && value !== null && "state" in value;
}

/**
 * Everything the page does at load. Exported (and awaited through `ready`) so a test can drive
 * a fully built page; the module still kicks it off itself, so users see no change.
 */
export async function initOptions(): Promise<void> {
  // options.html is a web-accessible resource, so any https page that knows the extension id can
  // frame it. Framed, this page would hand that page a settings form (password field included) and
  // a one-click Allow button to clickjack, so it renders nothing but a pointer to the real entry.
  if (window.top !== window) {
    document.body.textContent = "Open Web SIP Phone settings from the extensions menu.";
    return;
  }

  wireNav();
  wireAccount();
  wireSites();
  wireAdvanced();

  // ---- about ----
  $("about-version").textContent = chrome.runtime.getManifest().version;
  $("about-sipjs").textContent = __SIPJS_REF__;

  const requested = await Promise.resolve(chrome.storage.session.get(OPEN_SECTION_KEY))
    .then((items) => items[OPEN_SECTION_KEY] as string | undefined)
    .catch(() => undefined);

  await initAccount();
  await initTurn();
  const cfg = await loadConfig();
  await renderSites();

  // The deep link is resolved against the config that was just read, so the Allow button carries a
  // host that is already validated and de-duplicated and its click can go straight to Chrome.
  const siteLink = parseSiteDeepLink(location.search, cfg.allowSites);
  const hasSiteLink = siteLink.host !== null || siteLink.error !== null;
  const hasMicLink = location.hash === "#microphone";
  deepLinkActive = hasSiteLink || hasMicLink;

  // A deep link outranks the section requested through chrome.storage.session, but the key is
  // cleared either way so it never leaks into the next visit.
  if (requested !== undefined) {
    if (hasSiteLink || hasMicLink) {
      void chrome.storage.session.remove(OPEN_SECTION_KEY);
    } else {
      applyRequestedSection(requested);
    }
  }

  // Only one section can be shown: ?site= wins over #microphone when both are present.
  if (hasSiteLink) {
    applySiteDeepLink(siteLink);
  } else {
    applyMicrophoneHash();
  }

  try {
    const reply: unknown = await chrome.runtime.sendMessage({ target: "background", type: "ui/getState" });
    if (isTabState(reply)) {
      applyDisplayState(reply.state);
    }
  } catch {
    // No service worker answer (asleep, or no runtime yet): the status line and banner stay as they
    // are and the next state/update broadcast fills them in.
  }
}

export const ready = initOptions();
