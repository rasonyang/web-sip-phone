import type { DotPosition, StoredDotPosition } from "../shared/config.js";
import { isMsg, type Msg, type TabState } from "../shared/messages.js";
import { RuntimeState, type DisplayState } from "../shared/state.js";
import { applyPosition, clampPixels, positionFromPixels } from "./drag.js";
import { PageBridge } from "./page-bridge.js";
import { createRuntimeGuard } from "./runtime-guard.js";
import { WebSipPhoneView, type UiIntent } from "./view.js";

export const HOST_ID = "web-sip-phone-host";
/**
 * Dispatched on `document` by a starting instance before it builds anything. Every instance
 * already on the page — an orphan left behind by an extension reload or update, or a live one
 * when the same script is injected twice — tears itself down on it, synchronously, so exactly
 * one instance is left. A DOM event rather than a shared variable because an orphaned script
 * and its replacement do not share a JavaScript world; they share only the DOM.
 */
export const REPLACE_EVENT = "web-sip-phone:replace";

export interface WebSipPhoneInstance {
  /** Remove every trace of this instance from the page. Idempotent. */
  teardown(): void;
  /** True once teardown has run, for whatever reason. */
  readonly disposed: boolean;
}

/**
 * Mount the widget and the page bridge on the current page, replacing any earlier instance.
 * Returns null when the extension context is already gone at startup.
 */
export function mountWebSipPhone(): WebSipPhoneInstance | null {
  // Replace before building: the old instance removes its host and the presence marker, and
  // this one then sets them again. A host still present afterwards belongs to a script that
  // predates the replace event (1.0.5 and earlier) and cannot be told to go; its element is
  // removed here, although its listeners stay behind in its own world.
  document.dispatchEvent(new Event(REPLACE_EVENT));
  document.getElementById(HOST_ID)?.remove();

  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  // Every teardown step that touches something only this instance created is safe to run
  // before it exists: teardown can fire from inside construction (the guard's first check).
  let host: HTMLElement | null = null;
  let view: WebSipPhoneView | null = null;
  let bridge: PageBridge | null = null;
  let onRuntimeMessage: ((raw: unknown) => boolean) | null = null;
  let onResize: (() => void) | null = null;
  let onReplace: (() => void) | null = null;

  const guard = createRuntimeGuard(() => teardown());
  if (!guard.alive()) {
    return null;
  }
  const version = guard.call(() => chrome.runtime.getManifest().version, "");
  const extensionId = guard.call(() => chrome.runtime.id, "");
  if (disposed) {
    return null;
  }
  const send = (msg: Msg): void => guard.send(msg);

  host = document.createElement("div");
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  const hostEl = host;

  view = new WebSipPhoneView(
    hostEl,
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
    { version }
  );
  const viewRef = view;

  // The page-facing provisioning bridge. Attached before the first state fetch so the presence
  // marker on <html> is in place synchronously on injection, whatever the service worker is doing.
  bridge = new PageBridge({
    win: window,
    version,
    extensionId,
    send,
    // `undefined` and "no answer" must stay distinguishable: an explicit `undefined` reply is the
    // worker declining (this site is no longer allowed) and tears the bridge down, while a failed
    // sendMessage is only a sleeping or missing worker and is reported as `null`.
    request: async (m) => {
      const answer = await guard.request(m);
      if (answer === null) {
        return null;
      }
      return answer.reply === undefined ? undefined : (answer.reply as TabState);
    },
    alive: () => guard.alive(),
    // Declined means this site was removed from Allow Sites: the widget goes with the marker.
    onDeclined: () => teardown()
  });
  const bridgeRef = bridge;
  bridgeRef.attach();

  // No unload guard: a reload or navigation of this page does not own the call. The SIP session,
  // the WebRTC peer connection and the audio all live in the offscreen document, which the
  // service worker keeps alive while a call is in progress (design.md §6.5). A fresh content
  // script simply asks for the current state below and renders it.

  // Set once any TabState (initial fetch or broadcast) has been applied; gates the initial-fetch retry loop.
  let gotState = false;
  let lastPos: StoredDotPosition | null = null;
  let lastState: DisplayState | null = null;
  function applyTabState(ts: TabState): void {
    if (disposed) {
      return;
    }
    const firstState = !gotState;
    gotState = true;
    lastPos = ts.pos;
    lastState = ts.state;
    viewRef.update(ts.state);
    bridgeRef.publish(ts.state);
    applyPosition(hostEl, ts.pos);
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
    // Also the moment an orphan notices it is one: a returning user must not keep looking at a
    // widget frozen at whatever it showed when the extension went away.
    if (!guard.alive()) {
      return;
    }
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

  onRuntimeMessage = (raw: unknown): boolean => {
    if (isMsg(raw) && raw.target === "content") {
      if (raw.type === "state/update") {
        applyTabState({ state: raw.state, pos: raw.pos });
      } else if (raw.type === "mic/level") {
        // Arrives at 10 Hz while the panel is open; updates the meter bar only.
        viewRef.setMicLevel(raw.level);
      } else if (raw.type === "site/revoked") {
        // The site was removed from Allow Sites (or its host permission revoked) while this tab
        // was open. Withdraw at once rather than wait for the page's next hello to be declined.
        teardown();
      }
    }
    return false;
  };
  const listener = onRuntimeMessage;
  guard.call(() => chrome.runtime.onMessage.addListener(listener), undefined);

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

  viewRef.dot.addEventListener("pointerdown", (e) => {
    if (swallowClick) {
      viewRef.dot.removeEventListener("click", swallowClick, true);
      swallowClick = null;
    }
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = hostEl.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    viewRef.dot.setPointerCapture(e.pointerId);
  });
  viewRef.dot.addEventListener("pointermove", (e) => {
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
      hostEl.style.top = `${top}px`;
      hostEl.style.left = `${left}px`;
      hostEl.style.right = "auto";
      hostEl.style.bottom = "auto";
    }
  });
  viewRef.dot.addEventListener("pointerup", () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    if (moved) {
      const r = hostEl.getBoundingClientRect();
      const pos: DotPosition = positionFromPixels(r.left, r.top, window.innerWidth, window.innerHeight);
      applyPosition(hostEl, pos);
      lastPos = pos;
      send({ target: "background", type: "ui/savePosition", pos });
      // Swallow the click that follows a drag.
      swallowClick = (ce: MouseEvent) => {
        ce.stopImmediatePropagation();
        swallowClick = null;
      };
      viewRef.dot.addEventListener("click", swallowClick, { capture: true, once: true });
    }
  });
  // Positions are stored as fractions of the free space, so re-applying on resize keeps a
  // corner-parked widget in its corner and never strands it outside a shrunken viewport.
  onResize = (): void => {
    if (!dragging) {
      applyPosition(hostEl, lastPos);
    }
  };
  window.addEventListener("resize", onResize);

  viewRef.dot.addEventListener("pointercancel", () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    moved = false;
    // No save on cancel; restore whatever position was in effect before the drag.
    applyPosition(hostEl, lastPos);
  });

  onReplace = (): void => teardown();
  document.addEventListener(REPLACE_EVENT, onReplace);

  function teardown(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    cleanup();
  }

  /**
   * Safe to run more than once, and before construction has finished: the guard can declare the
   * context gone from inside any `chrome.*` call made while mounting.
   */
  function cleanup(): void {
    bridge?.detach();
    view?.destroy();
    for (const t of timers) {
      clearTimeout(t);
    }
    timers.clear();
    document.removeEventListener("visibilitychange", maybeNudgeRecovery);
    window.removeEventListener("focus", maybeNudgeRecovery);
    if (onResize) {
      window.removeEventListener("resize", onResize);
    }
    if (onReplace) {
      document.removeEventListener(REPLACE_EVENT, onReplace);
    }
    if (onRuntimeMessage) {
      const l = onRuntimeMessage;
      // Not through the guard: this runs precisely when the guard has declared the context gone.
      try {
        chrome.runtime?.onMessage?.removeListener(l);
      } catch {
        // An orphaned context may refuse even this; the listener can never fire again anyway.
      }
    }
    host?.remove();
    // The marker says "a live instance is here". Only withdrawn when no other instance has put
    // its own host on the page in the meantime.
    if (!document.getElementById(HOST_ID)) {
      delete document.documentElement.dataset.webSipPhone;
    }
  }

  // Initial state pull (broadcasts only reach us after the next change otherwise). MV3 service
  // workers can be asleep when this fires, so retry with backoff until state lands or we give up.
  // It is also what announces a replacement instance to an already-open page: the first state
  // is published unsolicited, so the page updates without having to say hello again.
  const INITIAL_STATE_RETRY_DELAYS_MS = [500, 1500, 4000];
  function fetchInitialState(attempt: number): void {
    if (gotState || disposed) {
      return;
    }
    void guard.request({ target: "background", type: "ui/getState" } satisfies Msg).then((answer) => {
      if (gotState || disposed) {
        return;
      }
      if (answer?.reply) {
        applyTabState(answer.reply as TabState);
      } else {
        scheduleInitialStateRetry(attempt);
      }
    });
  }
  function scheduleInitialStateRetry(attempt: number): void {
    if (gotState || disposed || attempt >= INITIAL_STATE_RETRY_DELAYS_MS.length) {
      if (!gotState && !disposed) {
        console.debug("[WebSipPhone] initial state fetch gave up after retries");
      }
      return;
    }
    later(() => fetchInitialState(attempt + 1), INITIAL_STATE_RETRY_DELAYS_MS[attempt]);
  }
  if (disposed) {
    // Invalidated part-way through mounting: listeners attached after that point are still up.
    cleanup();
    return null;
  }
  fetchInitialState(0);

  return {
    teardown,
    get disposed() {
      return disposed;
    }
  };
}
