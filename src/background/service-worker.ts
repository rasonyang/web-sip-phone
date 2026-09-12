import { originPatterns } from "../shared/allow-sites.js";
import { deriveEndpoints, iceServers, isAccountComplete, type WebSipPhoneConfig } from "../shared/config.js";
import { isMsg, type Msg, type OffscreenStatus, type RuntimeConfig, type TabState } from "../shared/messages.js";
import { computeDisplayState } from "./state-aggregator.js";
import { loadConfig, saveConfig } from "./config-store.js";
import { closeOffscreen, ensureOffscreen } from "./offscreen-manager.js";
import { TabTracker } from "./tab-tracker.js";

const SCRIPT_PREFIX = "web-sip-phone-";
const OPEN_SECTION_KEY = "websipphone.openSection";

let config: WebSipPhoneConfig;
let tracker: TabTracker;
let offscreenStatus: OffscreenStatus | null = null;
let runtimeStarted = false;
/** Fingerprint of the config the runtime was started with; detects account/TURN edits while running. */
let runtimeConfigKey: string | null = null;
let evaluating = Promise.resolve();
/**
 * Tabs whose status panel is expanded. Microphone metering is expensive and only meaningful
 * while somebody is watching a meter, so it runs exactly while this set is non-empty.
 */
const panelTabs = new Set<number>();
/** Last metering state the offscreen runtime was told about, so we only send on a change. */
let micMeterOn = false;

function desiredRuntimeConfig(): RuntimeConfig {
  const account = config.account!;
  const { sipUri, serverUrl } = deriveEndpoints(account);
  return { sipUri, serverUrl, username: account.username, password: account.password, iceServers: iceServers(config.turn) };
}

function displayState() {
  return computeDisplayState({
    configured: isAccountComplete(config.account),
    allowTabCount: tracker.count(),
    offscreen: offscreenStatus,
    identity: {
      account: config.account?.username ?? null,
      domain: config.account?.domain ?? null,
      // The transport URL actually in use — derived or overridden — so diagnostics show ws vs wss.
      serverUrl: isAccountComplete(config.account) ? deriveEndpoints(config.account).serverUrl : null,
      // "Configured" means calls can actually use it: an entry saved but switched off is not.
      turnConfigured: Boolean(config.turn?.enabled && config.turn.url)
    }
  });
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
      const shouldRun = isAccountComplete(config.account) && tracker.count() > 0;
      if (shouldRun) {
        const runtimeConfig = desiredRuntimeConfig();
        const key = JSON.stringify(runtimeConfig);
        const startMsg: Msg = { target: "offscreen", type: "runtime/start", config: runtimeConfig };
        if (!runtimeStarted) {
          await ensureOffscreen();
          await chrome.runtime.sendMessage(startMsg).catch(() => {});
          runtimeStarted = true;
          runtimeConfigKey = key;
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
        js: ["content.js"],
        matches: originPatterns(host),
        runAt: "document_idle" as const,
        persistAcrossSessions: true
      }))
    );
  }
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
    case "config/changed":
      config = await loadConfig();
      await syncContentScripts();
      await tracker.refresh();
      await evaluate();
      break;
  }
}

let initPromise: Promise<void> | null = null;

/** Idempotent: the top-level call and any test/wake-up call share one initialization. */
export function initServiceWorker(): Promise<void> {
  return (initPromise ??= doInit());
}

async function doInit(): Promise<void> {
  config = await loadConfig();
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
    return raw.type === "ui/getState"; // async response only for getState
  });

  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
      void chrome.runtime.openOptionsPage();
    }
  });

  await tracker.init();
  await syncContentScripts();
  await evaluate();
}

void initServiceWorker();
