import { originPatterns, urlMatchesAllowSite } from "../shared/allow-sites.js";
import { deriveEndpoints, iceServers, isAccountComplete, type WebSipPhoneConfig } from "../shared/config.js";
import { isMsg, type Msg, type OffscreenStatus, type RuntimeConfig, type TabState } from "../shared/messages.js";
import { parseProvisionRequest } from "../shared/page-protocol.js";
import type { CredentialSource, ProvisionFault, ProvisionStatus } from "../shared/state.js";
import { computeDisplayState } from "./state-aggregator.js";
import { loadConfig, saveConfig } from "./config-store.js";
import { closeOffscreen, ensureOffscreen } from "./offscreen-manager.js";
import {
  clearProvisioned,
  loadProvisioned,
  saveProvisioned,
  type ProvisionedCredential
} from "./provision-store.js";
import { TabTracker } from "./tab-tracker.js";

const SCRIPT_PREFIX = "web-sip-phone-";
/**
 * The content script as registered, shared with the injection into already-open tabs so the two
 * cannot drift: top frame only, and no stylesheet (the widget styles itself inside its shadow root).
 */
const CONTENT_SCRIPT = { js: ["content.js"], allFrames: false } as const;
const OPEN_SECTION_KEY = "websipphone.openSection";
/**
 * How long an Allow Site page gets to provision after it says hello before the absence is
 * reported as a fault. Long enough to cover the page's own round trip to its backend, short
 * enough that a user staring at "Connecting" learns why within a few seconds.
 */
const PROVISION_GRACE_MS = 10_000;

let config: WebSipPhoneConfig;
let tracker: TabTracker;
let offscreenStatus: OffscreenStatus | null = null;
let runtimeStarted = false;
/** Fingerprint of the config the runtime was started with; detects account/TURN edits while running. */
let runtimeConfigKey: string | null = null;
/**
 * Who the runtime is actually registered as — taken from the config that was really sent, and
 * kept in step with `runtimeConfigKey`. A config swap is deferred while a call is in progress,
 * so the pending credential and the running registration can disagree for the length of a call;
 * this is the half that is true.
 */
let runtimeIdentity: {
  account: string;
  domain: string | null;
  serverUrl: string;
  credentialSource: CredentialSource;
} | null = null;
let evaluating = Promise.resolve();
/**
 * Serializes every mutation of `provisioned` + its session-storage write. `handleMessage` is
 * void-ed, so two page messages would otherwise interleave their awaits and leave memory and
 * storage disagreeing about which credential is current.
 *
 * Strictly one-way against the evaluate() chain: a provision op may await evaluate() once its
 * own storage write is done, and evaluate() never awaits this one — so the two cannot deadlock.
 */
let provisionOps = Promise.resolve();
/**
 * Tabs whose status panel is expanded. Microphone metering is expensive and only meaningful
 * while somebody is watching a meter, so it runs exactly while this set is non-empty.
 */
const panelTabs = new Set<number>();
/** Last metering state the offscreen runtime was told about, so we only send on a change. */
let micMeterOn = false;
/**
 * The credential a host page pushed in, when there is one. It takes precedence over the manual
 * account for as long as it lives, and it lives only in memory + session storage (never in the
 * Options form's storage).
 */
let provisioned: ProvisionedCredential | null = null;
/** Fires at `provisioned.expiresAt`. MV3 kills timers freely, so evaluate() re-checks as well. */
let provisionExpiryTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Why provisioning has not produced a credential, for the Options banner. Worker memory only:
 * it describes this worker's view of an ongoing handshake, and a fault restored from storage
 * after an MV3 restart would report a page that never got the chance to answer this worker.
 */
let provisionFault: ProvisionFault = null;
/** When the current grace window opened (a `hello` with nothing held, or a re-sync). */
let awaitingProvisionSince: number | null = null;
/** Fires at the end of that window. MV3 kills timers freely, so evaluate() re-checks as well. */
let provisionGraceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Which credential the runtime actually uses. A provisioned credential wins for as long as it
 * is held, unless the user has explicitly overridden it by saving a manual account in Options
 * while provisioned — a manual account that merely predates the provision is not an override.
 */
function appliedSource(): CredentialSource {
  if (provisioned && !config.manualOverride) {
    return "PROVISIONED";
  }
  return isAccountComplete(config.account) ? "MANUAL" : "NONE";
}

/** What is held from a host page, which is not the same question as what is applied. */
function provisionStatus(): ProvisionStatus {
  if (!provisioned) {
    return "NONE";
  }
  return config.manualOverride ? "OVERRIDDEN" : "ACTIVE";
}

/** A provisioned credential counts as configured even with the Options account left empty. */
function hasCredential(): boolean {
  return appliedSource() !== "NONE";
}

function desiredRuntimeConfig(): RuntimeConfig {
  // The `provisioned &&` half is redundant with appliedSource() and kept for the narrowing.
  if (provisioned && appliedSource() === "PROVISIONED") {
    return {
      sipUri: `sip:${provisioned.account}@${provisioned.sipDomain}`,
      // Used verbatim: the host page owns the transport URL and the extension derives nothing.
      serverUrl: provisioned.wssUrl,
      username: provisioned.account,
      // No `password` key at all — a1Hash and password are mutually exclusive, and a config
      // carrying both would let the UA fall back to a plaintext secret that is not ours.
      a1Hash: provisioned.a1Hash,
      credentialSource: "provisioned",
      iceServers: iceServers(config.turn)
    };
  }
  const account = config.account!;
  const { sipUri, serverUrl } = deriveEndpoints(account);
  return {
    sipUri,
    serverUrl,
    username: account.username,
    password: account.password,
    credentialSource: "manual",
    iceServers: iceServers(config.turn)
  };
}

/** The identity a runtime config carries, read back out of the config that was actually sent. */
function identityOf(runtimeConfig: RuntimeConfig): NonNullable<typeof runtimeIdentity> {
  const at = runtimeConfig.sipUri.lastIndexOf("@");
  return {
    account: runtimeConfig.username,
    domain: at >= 0 ? runtimeConfig.sipUri.slice(at + 1) : null,
    serverUrl: runtimeConfig.serverUrl,
    credentialSource: runtimeConfig.credentialSource === "provisioned" ? "PROVISIONED" : "MANUAL"
  };
}

function displayState() {
  const applied = appliedSource();
  const usesProvisioned = applied === "PROVISIONED" && provisioned !== null;
  // Identity describes the credential actually in use. While the runtime is up that is the
  // config it was started with, never the one waiting behind it: evaluate() defers a swap for
  // the length of a call, and reporting the pending credential there would describe a
  // registration that does not exist yet. With nothing running, the pending sources are it.
  //
  // The `provision*` fields answer a different question — what is *held* from a host page —
  // and so are read from the held credential in every case, including while it is overridden
  // or while its swap is still deferred behind a call.
  const live = runtimeStarted ? runtimeIdentity : null;
  return computeDisplayState({
    configured: applied !== "NONE",
    allowTabCount: tracker.count(),
    offscreen: offscreenStatus,
    identity: {
      account: live ? live.account : usesProvisioned ? provisioned!.account : (config.account?.username ?? null),
      domain: live ? live.domain : usesProvisioned ? provisioned!.sipDomain : (config.account?.domain ?? null),
      // The transport URL actually in use — derived or overridden — so diagnostics show ws vs wss.
      serverUrl: live
        ? live.serverUrl
        : usesProvisioned
          ? provisioned!.wssUrl
          : applied === "MANUAL"
            ? deriveEndpoints(config.account!).serverUrl
            : null,
      // "Configured" means calls can actually use it: an entry saved but switched off is not.
      turnConfigured: Boolean(config.turn?.enabled && config.turn.url),
      credentialSource: live ? live.credentialSource : applied,
      provisionedBy: provisioned?.origin ?? null,
      provisionStatus: provisionStatus(),
      provisionedAccount: provisioned?.account ?? null,
      provisionedDomain: provisioned?.sipDomain ?? null,
      provisionLastSyncAt: provisioned?.receivedAt ?? null,
      provisionFault,
      manualOverride: config.manualOverride
    }
  });
}

/** Forget the provisioned credential everywhere: memory, its expiry timer, and session storage. */
async function dropProvisioned(): Promise<void> {
  if (provisionExpiryTimer) {
    clearTimeout(provisionExpiryTimer);
    provisionExpiryTimer = null;
  }
  provisioned = null;
  await clearProvisioned();
}

/** Runs `fn` after every provision mutation queued before it. Never rejects. */
function queueProvisionOp(fn: () => Promise<void>): Promise<void> {
  provisionOps = provisionOps
    .then(fn)
    .catch((e) => console.warn("[WebSipPhone] provision op failed", e));
  return provisionOps;
}

function onProvisionExpired(): void {
  void queueProvisionOp(async () => {
    // The clamp below fires the timer early for a far-future expiry. That is a re-arm, not an
    // expiry: dropping the credential here would revoke it long before it actually expires.
    if (provisioned && provisioned.expiresAt > Date.now()) {
      armProvisionExpiry();
      return;
    }
    await dropProvisioned();
    await evaluate();
  });
}

/** setTimeout's delay is a signed 32-bit int; anything larger fires immediately instead. */
function armProvisionExpiry(): void {
  if (provisionExpiryTimer) {
    clearTimeout(provisionExpiryTimer);
    provisionExpiryTimer = null;
  }
  if (!provisioned) {
    return;
  }
  const delay = Math.min(Math.max(provisioned.expiresAt - Date.now(), 0), 2 ** 31 - 1);
  provisionExpiryTimer = setTimeout(() => onProvisionExpired(), delay);
}

/** Close the grace window without reporting a fault: something arrived, or nobody is waiting. */
function clearProvisionGrace(): void {
  if (provisionGraceTimer) {
    clearTimeout(provisionGraceTimer);
    provisionGraceTimer = null;
  }
  awaitingProvisionSince = null;
}

/** (Re)open the grace window from now. */
function armProvisionGrace(): void {
  if (provisionGraceTimer) {
    clearTimeout(provisionGraceTimer);
  }
  awaitingProvisionSince = Date.now();
  provisionGraceTimer = setTimeout(() => {
    provisionGraceTimer = null;
    if (checkProvisionGrace()) {
      void broadcast();
    }
  }, PROVISION_GRACE_MS);
}

/**
 * Report NOT_RECEIVED if the window has run out with nothing held. Called both from the timer
 * and from evaluate(), because an MV3 worker can be killed between arming the timer and its
 * deadline: the window's start time is authoritative, the timer is only an optimisation.
 *
 * Returns true when it changed the fault, so the caller can decide whether to broadcast.
 */
function checkProvisionGrace(): boolean {
  if (awaitingProvisionSince === null || provisioned || Date.now() - awaitingProvisionSince < PROVISION_GRACE_MS) {
    return false;
  }
  clearProvisionGrace();
  provisionFault = "NOT_RECEIVED";
  return true;
}

/** Metering follows the panels: on while at least one is expanded, off the moment none are. */
async function syncMicMeter(): Promise<void> {
  const on = runtimeStarted && panelTabs.size > 0;
  if (on === micMeterOn) {
    return;
  }
  micMeterOn = on;
  const msg: Msg = { target: "offscreen", type: "runtime/micMeter", on };
  await chrome.runtime.sendMessage(msg).catch(() => {});
}

function tabState(): TabState {
  return { state: displayState(), pos: config.dotPosition };
}

/** True while the offscreen runtime reports a call in a progress state (design.md §6.5). */
function callActive(): boolean {
  return offscreenStatus?.callInProgress ?? false;
}

async function broadcast(): Promise<void> {
  const optionsMsg: Msg = { target: "options", type: "state/update", state: displayState() };
  void chrome.runtime.sendMessage(optionsMsg).catch(() => {});
  const ts = tabState();
  for (const tabId of tracker.ids()) {
    const msg: Msg = { target: "content", type: "state/update", state: ts.state, pos: ts.pos };
    void chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }
}

/**
 * Start/stop the offscreen SIP runtime to match config + tab reality. Serialized to avoid races.
 *
 * Runtime lifetime rule (design.md §6.5):
 *
 *     keep the runtime alive if allowTabCount > 0 OR callActive
 *
 * so the runtime is destroyed only when there is no Allow Site tab *and* no call in progress.
 * Page lifecycle never owns the call: a reload or a navigation may cost the tab, not the call.
 */
function evaluate(): Promise<void> {
  evaluating = evaluating.then(async () => {
    try {
      // Belt and braces against the expiry timer: an MV3 worker can be killed and restarted
      // between arming it and its deadline, so the credential's own clock is authoritative.
      if (provisioned && provisioned.expiresAt <= Date.now()) {
        await dropProvisioned();
      }
      // A provisioned credential belongs to the host page that pushed it. With no Allow Site
      // tab left open at all — not merely none on the provisioning site — there is nobody left
      // to own it, so it is dropped here even though the runtime teardown below still waits
      // for `!callActive()`. (Removing the provisioning site from Allow Sites revokes the
      // credential too; that is handled in the `config/changed` case, where the list changes.)
      if (tracker.count() === 0 && provisioned) {
        await dropProvisioned();
      }
      // Same reasoning as the expiry check above: the grace window's deadline is enforced here
      // too, so a killed timer costs at most one evaluation's delay rather than the fault.
      checkProvisionGrace();
      const shouldRun = hasCredential() && tracker.count() > 0;
      if (shouldRun) {
        const runtimeConfig = desiredRuntimeConfig();
        const key = JSON.stringify(runtimeConfig);
        const startMsg: Msg = { target: "offscreen", type: "runtime/start", config: runtimeConfig };
        if (!runtimeStarted) {
          await ensureOffscreen();
          await chrome.runtime.sendMessage(startMsg).catch(() => {});
          runtimeStarted = true;
          runtimeConfigKey = key;
          runtimeIdentity = identityOf(runtimeConfig);
          micMeterOn = false; // a fresh runtime starts with metering off
        } else if (key !== runtimeConfigKey && !callActive()) {
          // Account/TURN changed while the runtime is up. SipRuntime.start() is a no-op
          // while running, so an explicit stop must precede the restart. Deferred while a
          // call is in progress (a settings edit must not drop a live call); the
          // offscreen/status handler re-evaluates once the call ends.
          const stopMsg: Msg = { target: "offscreen", type: "runtime/stop" };
          await chrome.runtime.sendMessage(stopMsg).catch(() => {});
          await chrome.runtime.sendMessage(startMsg).catch(() => {});
          runtimeConfigKey = key;
          runtimeIdentity = identityOf(runtimeConfig);
          micMeterOn = false;
        }
      } else if (runtimeStarted && !callActive()) {
        // The `!callActive()` half of the lifetime rule. Teardown runs SipRuntime.stop() →
        // CallSessionManager.terminate() → a real BYE, so doing it during a call would hang up
        // on the caller. Losing the last Allow Site tab is not evidence the user wants the call
        // over: a refresh, an in-tab navigation to a route outside the Allow Site, or a closed
        // tab all look identical here, and none of them owns the call. Deferred, not cancelled:
        // every call-state change reports a status and that handler re-evaluates, so this runs
        // the moment the call ends.
        const msg: Msg = { target: "offscreen", type: "runtime/stop" };
        await chrome.runtime.sendMessage(msg).catch(() => {});
        await closeOffscreen();
        runtimeStarted = false;
        runtimeConfigKey = null;
        runtimeIdentity = null;
        micMeterOn = false;
        offscreenStatus = null;
      }
      await broadcast();
      // A runtime that has just (re)started knows nothing about the open panels.
      await syncMicMeter();
    } catch (e) {
      console.warn("[WebSipPhone] evaluate failed", e);
    }
  });
  return evaluating;
}

async function syncContentScripts(): Promise<void> {
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const wantedIds = new Set(config.allowSites.map((h) => SCRIPT_PREFIX + h));
  const staleIds = registered.map((s) => s.id).filter((id) => id.startsWith(SCRIPT_PREFIX) && !wantedIds.has(id));
  if (staleIds.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: staleIds });
  }
  const registeredIds = new Set(registered.map((s) => s.id));
  const toAdd = config.allowSites.filter((h) => !registeredIds.has(SCRIPT_PREFIX + h));
  if (toAdd.length > 0) {
    await chrome.scripting.registerContentScripts(
      toAdd.map((host) => ({
        id: SCRIPT_PREFIX + host,
        js: [...CONTENT_SCRIPT.js],
        allFrames: CONTENT_SCRIPT.allFrames,
        matches: originPatterns(host),
        runAt: "document_idle" as const,
        persistAcrossSessions: true
      }))
    );
  }
}

/**
 * Inject the content script into every open tab already showing one of `sites`.
 *
 * A registered content script only runs on the next navigation, so without this a tab that was
 * open when the extension was installed or updated, or when its site was added to Allow Sites,
 * shows nothing until the user refreshes it — and after an update its old content script is
 * orphaned. The injected instance replaces any earlier one itself (content/instance.ts).
 *
 * Only tabs whose origin the user has actually granted: a site can sit in Allow Sites with its
 * host permission since revoked. Every tab stands alone — a discarded tab, a navigation racing
 * the injection or an error page must not keep the others from getting the script.
 */
async function injectIntoOpenTabs(sites: string[]): Promise<void> {
  if (sites.length === 0) {
    return;
  }
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || !tab.url || !urlMatchesAllowSite(tab.url, sites)) {
        return;
      }
      try {
        const granted = await chrome.permissions.contains({ origins: [`${new URL(tab.url).origin}/*`] });
        if (!granted) {
          return;
        }
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: CONTENT_SCRIPT.allFrames },
          files: [...CONTENT_SCRIPT.js]
        });
      } catch (e) {
        console.debug("[WebSipPhone] content script injection skipped", tab.id, e);
      }
    })
  );
}

/** Tell the content script in each `tabIds` tab that its site is no longer allowed. */
function revokeTabs(tabIds: number[]): void {
  const msg: Msg = { target: "content", type: "site/revoked" };
  for (const tabId of tabIds) {
    // A tab with no content script (never injected, already torn down) simply has no receiver.
    void chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }
}

/**
 * Withdraw the widget and presence marker from open tabs on sites just removed from Allow Sites.
 * The removed tab gets no broadcasts any more, so without this its content script would keep
 * showing the last state — and the page would see the marker — until the page happened to say
 * hello and be declined.
 */
async function revokeOpenTabs(sites: string[]): Promise<void> {
  if (sites.length === 0) {
    return;
  }
  const tabs = await chrome.tabs.query({});
  revokeTabs(
    tabs.filter((t) => t.id !== undefined && t.url && urlMatchesAllowSite(t.url, sites)).map((t) => t.id!)
  );
}

/**
 * Host permission revoked outside Options (chrome://extensions, the toolbar menu) while the site
 * stays in Allow Sites. The registered script can no longer run there, so open tabs whose origin
 * is no longer granted are withdrawn the same way a removed site's are.
 */
async function revokeUngrantedTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const ungranted: number[] = [];
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || !tab.url || !urlMatchesAllowSite(tab.url, config.allowSites)) {
        return;
      }
      try {
        if (!(await chrome.permissions.contains({ origins: [`${new URL(tab.url).origin}/*`] }))) {
          ungranted.push(tab.id);
        }
      } catch {
        // Unanswerable for this tab; leave it alone.
      }
    })
  );
  revokeTabs(ungranted);
}

/**
 * The URL a `page/*` message really came from, or null when it did not come from a top-level
 * Allow Site page.
 *
 * The content script relays on behalf of a page, and `sender` is the one part of the message a
 * page cannot forge: Chrome fills it in. Requiring the sending *document's* URL to match an
 * Allow Site keeps an unlisted site from provisioning a credential, and requiring frame 0
 * keeps an iframe embedded in an Allow Site page (which the top-level page never vouched for)
 * from doing it.
 *
 * `frameId` must be exactly 0 — an absent one is not evidence of a main frame, and treating it
 * as one would accept whatever context the browser declined to place. `sender.url` is preferred
 * over `sender.tab.url` because they can differ: `tab.url` is the tab's top-level document,
 * which a subframe or a mid-navigation document does not share.
 */
function pageSenderUrl(sender: chrome.runtime.MessageSender): string | null {
  if (sender.frameId !== 0) {
    return null;
  }
  // A prerendered document is speculative: nobody has seen it and the user has acted on
  // nothing in it. It must not be able to swap the credential out from under the visible page.
  if ((sender as { documentLifecycle?: string }).documentLifecycle === "prerender") {
    return null;
  }
  const url = sender.url ?? sender.tab?.url;
  if (typeof url !== "string" || !urlMatchesAllowSite(url, config.allowSites)) {
    return null;
  }
  return url;
}

async function handleMessage(msg: Msg, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void): Promise<void> {
  switch (msg.type) {
    case "offscreen/status":
      offscreenStatus = msg.status;
      if (msg.status.phase === "stopped" && !msg.status.errors.includes("MICROPHONE_BLOCKED")) {
        // The runtime stops itself when the microphone gate fails at start (design §6.1) and
        // the worker would otherwise keep believing it is running. Once that blocker clears —
        // typically the panel's "Test microphone" passing — it needs a fresh start.
        runtimeStarted = false;
        runtimeConfigKey = null;
        runtimeIdentity = null;
      }
      // evaluate() (which ends in a broadcast) rather than broadcast() directly, so a
      // config change deferred during a call is applied as soon as the call ends.
      await evaluate();
      break;
    case "ui/getState": {
      // A content script asks exactly once, on load — so this is also the signal that a tab was
      // (re)loaded. Its panel starts collapsed, and any entry left over from before a refresh
      // would keep microphone metering running for a panel that no longer exists.
      const tabId = sender.tab?.id;
      if (tabId !== undefined && panelTabs.delete(tabId)) {
        await syncMicMeter();
      }
      sendResponse(tabState());
      break;
    }
    case "ui/retry":
      await chrome.runtime.sendMessage({ target: "offscreen", type: "runtime/retry" } satisfies Msg).catch(() => {});
      break;
    case "ui/openOptions":
      await chrome.storage.session.set({ [OPEN_SECTION_KEY]: msg.section ?? "account" });
      await chrome.runtime.openOptionsPage();
      break;
    case "ui/savePosition":
      config = await saveConfig({ dotPosition: msg.pos });
      await broadcast();
      break;
    case "ui/panelState": {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) {
        if (msg.open) {
          panelTabs.add(tabId);
        } else {
          panelTabs.delete(tabId);
        }
        await syncMicMeter();
      }
      break;
    }
    case "ui/testMic":
      // Deliberately fire-and-forget: the result comes back through the normal status
      // broadcast (the offscreen runtime reports as soon as the test finishes), which every
      // tab sees. A request/response round trip here is unreliable — `runtime.sendMessage`
      // reaches every extension context, and a context that returns without responding can
      // close the port before the offscreen document's async reply arrives.
      void chrome.runtime.sendMessage({ target: "offscreen", type: "runtime/testMic" } satisfies Msg).catch(() => {});
      break;
    case "offscreen/micLevel":
      // Deliberately not a full broadcast: levels arrive at 10 Hz and only interest the tabs
      // that are actually showing a meter.
      if (offscreenStatus) {
        offscreenStatus = { ...offscreenStatus, micLevel: msg.level };
      }
      for (const tabId of panelTabs) {
        void chrome.tabs.sendMessage(tabId, { target: "content", type: "mic/level", level: msg.level } satisfies Msg).catch(() => {});
      }
      break;
    case "config/changed": {
      // Manual config only. Which source actually wins is decided by appliedSource(), so an
      // edit made while provisioned changes nothing the runtime can see unless it also sets
      // `manualOverride` — and the fingerprint comparison in evaluate() therefore leaves the
      // registration alone. Clearing the override the same way swaps back to the provisioned
      // credential, since the fingerprint changes again.
      const previous = config;
      config = await loadConfig();
      await queueProvisionOp(async () => {
        // A provisioned credential is accepted on the strength of its origin being an Allow
        // Site. Taking that site off the list withdraws exactly that, so the credential goes
        // with it — otherwise a removed site's registration would outlive the permission it
        // rested on. Queued so it cannot interleave with a provision arriving at the same
        // moment.
        if (provisioned && !config.allowSites.includes(new URL(provisioned.origin).hostname)) {
          await dropProvisioned();
        }
        // Sign Out clears everything, not just the half the user can see. Options clears the
        // account (and the override with it); a held provisioned credential left behind would
        // re-register the moment this evaluation ran, which reads as "sign out did nothing".
        // Only the transition counts: booting with no account is not a sign-out.
        if (previous.account !== null && config.account === null && !config.manualOverride) {
          clearProvisionGrace();
          provisionFault = null;
          await dropProvisioned();
        }
      });
      await syncContentScripts();
      await tracker.refresh();
      await evaluate();
      // After evaluate(), so an injected script's ui/getState is answered with the new state.
      await injectIntoOpenTabs(config.allowSites.filter((h) => !previous.allowSites.includes(h)));
      await revokeOpenTabs(previous.allowSites.filter((h) => !config.allowSites.includes(h)));
      break;
    }
    case "ui/resync":
      // The user asking "try again" from Options. Nothing is sent to the page — a re-sync is a
      // fresh state broadcast, which every Allow Site tab republishes to its page, and it is
      // the page's own business whether that warrants provisioning again. What it does own is
      // the fault: the old one is retracted and a new window opened to judge the answer by.
      provisionFault = null;
      armProvisionGrace();
      await broadcast();
      break;
    case "page/hello": {
      // Answered with the same payload a content script gets on load, so a host page can
      // read registration state before deciding whether to provision. An unallowed sender
      // gets `undefined` — never a hint about what is configured.
      const helloUrl = pageSenderUrl(sender);
      sendResponse(helloUrl !== null ? tabState() : undefined);
      // A page that says hello with nothing held is expected to provision. Give it the grace
      // window, once: a second hello (a reload, a second tab, or the same page again — the
      // content script forwards every hello, cached state or not) must not keep resetting the
      // deadline, and a fault already reported stands until a provision or a re-sync retracts
      // it. Not a fault in itself — plenty of Allow Sites never provision at all.
      if (helloUrl !== null && !provisioned && provisionFault === null && awaitingProvisionSince === null) {
        armProvisionGrace();
      }
      break;
    }
    case "page/provision": {
      const senderUrl = pageSenderUrl(sender);
      if (senderUrl === null) {
        break;
      }
      // Re-validated here rather than trusted from the relay: the content script's parse is the
      // page's own boundary, and a malformed account or realm reaching the runtime would build
      // an unusable SIP URI and wedge the registration until something else changes.
      const cred = parseProvisionRequest(msg.credential);
      // Already expired on arrival counts as invalid too: accepting it would register with a
      // dead credential, and it is a rejected provision, not an absent one — reporting
      // NOT_RECEIVED for something that was received would send the user looking in the
      // wrong place.
      if (!cred || cred.expiresAt <= Date.now()) {
        provisionFault = "INVALID";
        clearProvisionGrace();
        await broadcast();
        break;
      }
      const origin = new URL(senderUrl).origin;
      await queueProvisionOp(async () => {
        provisioned = { ...cred, origin, receivedAt: Date.now() };
        provisionFault = null;
        clearProvisionGrace();
        await saveProvisioned(provisioned);
        armProvisionExpiry();
        await evaluate();
      });
      break;
    }
    case "page/deprovision":
      if (pageSenderUrl(sender) === null) {
        break;
      }
      await queueProvisionOp(async () => {
        // A page that withdraws its credential on purpose is not waiting for one: no fault,
        // and no window left open to produce one.
        clearProvisionGrace();
        provisionFault = null;
        await dropProvisioned();
        await evaluate();
      });
      break;
  }
}

let initPromise: Promise<void> | null = null;

/** Idempotent: the top-level call and any test/wake-up call share one initialization. */
export function initServiceWorker(): Promise<void> {
  return (initPromise ??= doInit());
}

async function doInit(): Promise<void> {
  // Registered before the first await: an MV3 worker only receives the events it has a listener
  // for by the end of its first turn, and onInstalled is dispatched once, right after startup.
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
      void chrome.runtime.openOptionsPage();
    }
    if (details.reason === "install" || details.reason === "update") {
      // Open Allow Site tabs get the new content script now; after an update their old one is
      // orphaned and would otherwise sit there frozen until the tab is refreshed. Config is
      // only read once initialisation has finished.
      void initServiceWorker().then(() => injectIntoOpenTabs(config.allowSites));
    }
  });
  chrome.permissions.onRemoved.addListener(() => {
    void initServiceWorker().then(() => revokeUngrantedTabs());
  });

  config = await loadConfig();
  // An MV3 worker is killed whenever it goes idle; a restart must come back with the same
  // credential rather than silently demoting a provisioned registration to the manual account.
  provisioned = await loadProvisioned();
  armProvisionExpiry();
  tracker = new TabTracker(() => config.allowSites);
  tracker.onChange(() => void evaluate());
  // A closed tab takes its panel with it; otherwise metering would run for a ghost.
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (panelTabs.delete(tabId)) {
      void syncMicMeter();
    }
  });

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    if (!isMsg(raw) || raw.target !== "background") {
      return false;
    }
    void handleMessage(raw, sender, sendResponse);
    return raw.type === "ui/getState" || raw.type === "page/hello"; // async response only for these
  });

  await tracker.init();
  await syncContentScripts();
  await evaluate();
}

void initServiceWorker();
