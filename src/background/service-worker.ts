import { originPattern } from "../shared/allow-sites.js";
import { deriveEndpoints, iceServers, isAccountComplete, type WebSipPhoneConfig } from "../shared/config.js";
import { isMsg, type Msg, type OffscreenStatus, type TabState } from "../shared/messages.js";
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
let evaluating = Promise.resolve();

function displayState() {
  return computeDisplayState({
    configured: isAccountComplete(config.account),
    allowTabCount: tracker.count(),
    offscreen: offscreenStatus
  });
}

function tabState(tabId: number): TabState {
  return {
    state: displayState(),
    guardUnload: (offscreenStatus?.callInProgress ?? false) && tracker.isLast(tabId),
    pos: config.dotPosition
  };
}

async function broadcast(): Promise<void> {
  const optionsMsg: Msg = { target: "options", type: "state/update", state: displayState() };
  void chrome.runtime.sendMessage(optionsMsg).catch(() => {});
  for (const tabId of tracker.ids()) {
    const ts = tabState(tabId);
    const msg: Msg = { target: "content", type: "state/update", state: ts.state, guardUnload: ts.guardUnload, pos: ts.pos };
    void chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }
}

/** Start/stop the offscreen SIP runtime to match config + tab reality. Serialized to avoid races. */
function evaluate(): Promise<void> {
  evaluating = evaluating.then(async () => {
    try {
      const shouldRun = isAccountComplete(config.account) && tracker.count() > 0;
      if (shouldRun && !runtimeStarted) {
        await ensureOffscreen();
        const account = config.account!;
        const { sipUri, wssUrl } = deriveEndpoints(account);
        const msg: Msg = {
          target: "offscreen",
          type: "runtime/start",
          config: { sipUri, wssUrl, username: account.username, password: account.password, iceServers: iceServers(config.turn) }
        };
        await chrome.runtime.sendMessage(msg).catch(() => {});
        runtimeStarted = true;
      } else if (!shouldRun && runtimeStarted) {
        const msg: Msg = { target: "offscreen", type: "runtime/stop" };
        await chrome.runtime.sendMessage(msg).catch(() => {});
        await closeOffscreen();
        runtimeStarted = false;
        offscreenStatus = null;
      }
      await broadcast();
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
        matches: [originPattern(host)],
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
      await broadcast();
      break;
    case "ui/getState":
      sendResponse(tabState(sender.tab?.id ?? -1));
      break;
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
