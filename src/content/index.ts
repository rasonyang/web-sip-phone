import type { DotPosition, StoredDotPosition } from "../shared/config.js";
import { isMsg, type Msg, type TabState } from "../shared/messages.js";
import { RuntimeState, type DisplayState } from "../shared/state.js";
import { applyPosition, clampPixels, positionFromPixels } from "./drag.js";
import { PageBridge } from "./page-bridge.js";
import { WebSipPhoneView, type UiIntent } from "./view.js";

// Top-level pages only; dynamic registration already excludes iframes, this is defense in depth.
if (window.top === window && !document.getElementById("web-sip-phone-host")) {
  const host = document.createElement("div");
  host.id = "web-sip-phone-host";
  document.documentElement.appendChild(host);

  const send = (msg: Msg): void => void chrome.runtime.sendMessage(msg).catch(() => {});

  const view = new WebSipPhoneView(
    host,
    (intent: UiIntent) => {
      switch (intent.kind) {
        case "retry":
          send({ target: "background", type: "ui/retry" });
          break;
        case "panelState":
          // Drives microphone metering in the offscreen document — the content script must
          // never touch the microphone itself.
          send({ target: "background", type: "ui/panelState", open: intent.open });
          break;
        case "testMic":
          // The outcome arrives with the next status broadcast, not as a reply (see the
          // service worker's ui/testMic handler); the view resolves its own pending state.
          send({ target: "background", type: "ui/testMic" });
          break;
        case "micBlocked":
          // An offscreen document cannot show a permission prompt; only the Options page can,
          // so a failed test hands the user straight to it.
          send({ target: "background", type: "ui/openOptions", section: "advanced" });
          break;
        default:
          send({ target: "background", type: "ui/openOptions", section: intent.section });
      }
    },
    { version: chrome.runtime.getManifest().version }
  );

  // The page-facing provisioning bridge. Attached before the first state fetch so the presence
  // marker on <html> is in place synchronously on injection, whatever the service worker is doing.
  const bridge = new PageBridge({
    win: window,
    version: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    send,
    // `undefined` and "no answer" must stay distinguishable: an explicit `undefined` reply is the
    // worker declining (this site is no longer allowed) and tears the bridge down, while a rejected
    // sendMessage is only a sleeping or missing worker and is reported as `null`.
    request: (m) =>
      chrome.runtime
        .sendMessage(m)
        .then((r) => (r === undefined ? undefined : (r as TabState)))
        .catch(() => null)
  });
  bridge.attach();

  // No unload guard: a reload or navigation of this page does not own the call. The SIP session,
  // the WebRTC peer connection and the audio all live in the offscreen document, which the
  // service worker keeps alive while a call is in progress (design.md §6.5). A fresh content
  // script simply asks for the current state below and renders it.

  // Set once any TabState (initial fetch or broadcast) has been applied; gates the initial-fetch retry loop.
  let gotState = false;
  let lastPos: StoredDotPosition | null = null;
  let lastState: DisplayState | null = null;
  function applyTabState(ts: TabState): void {
    const firstState = !gotState;
    gotState = true;
    lastPos = ts.pos;
    lastState = ts.state;
    view.update(ts.state);
    bridge.publish(ts.state);
    applyPosition(host, ts.pos);
    if (firstState) {
      // Opening the page while the voice link is in a failed state should recover it
      // without requiring the user to find the Retry button.
      maybeNudgeRecovery();
    }
  }

  // Coming back to the page is the user's natural "make it work" gesture: if the voice
  // link is unhealthy when this tab is (re)opened or refocused, nudge the runtime to retry
  // immediately instead of waiting for its own timers. Throttled so tab-flipping cannot
  // spam the runtime, and a no-op whenever the link is healthy.
  const NUDGE_MIN_INTERVAL_MS = 10000;
  let lastNudgeAt = 0;
  function maybeNudgeRecovery(): void {
    if (document.visibilityState !== "visible" || !lastState) {
      return;
    }
    const s = lastState;
    const unhealthy =
      s.error !== null ||
      s.reconnecting ||
      s.runtime === RuntimeState.Connecting ||
      s.runtime === RuntimeState.Registering;
    if (!unhealthy) {
      return;
    }
    const now = Date.now();
    if (now - lastNudgeAt < NUDGE_MIN_INTERVAL_MS) {
      return;
    }
    lastNudgeAt = now;
    send({ target: "background", type: "ui/retry" });
  }
  document.addEventListener("visibilitychange", maybeNudgeRecovery);
  window.addEventListener("focus", maybeNudgeRecovery);

  chrome.runtime.onMessage.addListener((raw) => {
    if (isMsg(raw) && raw.target === "content") {
      if (raw.type === "state/update") {
        applyTabState({ state: raw.state, pos: raw.pos });
      } else if (raw.type === "mic/level") {
        // Arrives at 10 Hz while the panel is open; updates the meter bar only.
        view.setMicLevel(raw.level);
      }
    }
    return false;
  });

  // Drag with click suppression: a pointer travel > 4px is a drag, not a click.
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let offsetX = 0;
  let offsetY = 0;
  // Reference to the one-shot click-swallow listener so a fresh interaction can clear a stale one
  // (e.g. a drag that ended in pointercancel, leaving no click for it to swallow).
  let swallowClick: ((ce: MouseEvent) => void) | null = null;

  view.dot.addEventListener("pointerdown", (e) => {
    if (swallowClick) {
      view.dot.removeEventListener("click", swallowClick, true);
      swallowClick = null;
    }
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = host.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    view.dot.setPointerCapture(e.pointerId);
  });
  view.dot.addEventListener("pointermove", (e) => {
    if (!dragging) {
      return;
    }
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 4) {
      moved = true;
      // Free movement on both axes, clamped so the widget can never be dragged off screen.
      const { left, top } = clampPixels(
        e.clientX - offsetX,
        e.clientY - offsetY,
        window.innerWidth,
        window.innerHeight
      );
      host.style.top = `${top}px`;
      host.style.left = `${left}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    }
  });
  view.dot.addEventListener("pointerup", () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    if (moved) {
      const r = host.getBoundingClientRect();
      const pos: DotPosition = positionFromPixels(r.left, r.top, window.innerWidth, window.innerHeight);
      applyPosition(host, pos);
      lastPos = pos;
      send({ target: "background", type: "ui/savePosition", pos });
      // Swallow the click that follows a drag.
      swallowClick = (ce: MouseEvent) => {
        ce.stopImmediatePropagation();
        swallowClick = null;
      };
      view.dot.addEventListener("click", swallowClick, { capture: true, once: true });
    }
  });
  // Positions are stored as fractions of the free space, so re-applying on resize keeps a
  // corner-parked widget in its corner and never strands it outside a shrunken viewport.
  window.addEventListener("resize", () => {
    if (!dragging) {
      applyPosition(host, lastPos);
    }
  });

  view.dot.addEventListener("pointercancel", () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    moved = false;
    // No save on cancel; restore whatever position was in effect before the drag.
    applyPosition(host, lastPos);
  });

  // Initial state pull (broadcasts only reach us after the next change otherwise). MV3 service
  // workers can be asleep when this fires, so retry with backoff until state lands or we give up.
  const INITIAL_STATE_RETRY_DELAYS_MS = [500, 1500, 4000];
  function fetchInitialState(attempt: number): void {
    if (gotState) {
      return;
    }
    chrome.runtime
      .sendMessage({ target: "background", type: "ui/getState" } satisfies Msg)
      .then((ts) => {
        if (gotState) {
          return;
        }
        if (ts) {
          applyTabState(ts as TabState);
        } else {
          scheduleInitialStateRetry(attempt);
        }
      })
      .catch(() => {
        if (!gotState) {
          scheduleInitialStateRetry(attempt);
        }
      });
  }
  function scheduleInitialStateRetry(attempt: number): void {
    if (gotState || attempt >= INITIAL_STATE_RETRY_DELAYS_MS.length) {
      if (!gotState) {
        console.debug("[WebSipPhone] initial state fetch gave up after retries");
      }
      return;
    }
    setTimeout(() => fetchInitialState(attempt + 1), INITIAL_STATE_RETRY_DELAYS_MS[attempt]);
  }
  fetchInitialState(0);
}
