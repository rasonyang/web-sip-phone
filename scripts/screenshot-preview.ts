/**
 * Store-screenshot harness. Mounts the real `WebSipPhoneView` on the demo page with a scripted
 * `DisplayState`, so shots 1-3 can be re-taken from source after any UI change instead of
 * requiring a live registration, a microphone grant and an inbound call.
 *
 * Everything visible is the shipped component: the same class, the same shadow DOM, the same
 * copy, positioned by the same `applyPosition`. Only the *values* are scripted (which extension,
 * how long until the registration expires, how loud the room is) — and they are frozen, so
 * re-running the shoot produces a byte-identical countdown rather than a new diff every time.
 */
import { applyPosition } from "../src/content/drag.js";
import { WebSipPhoneView } from "../src/content/view.js";
import { RuntimeState, IDLE_LINK, EMPTY_DETAILS, type DisplayState } from "../src/shared/state.js";

declare const __VERSION__: string;

/** Frozen clock: the countdown in the Signaling row must not drift between shoots. */
const NOW = Date.parse("2026-08-21T09:14:00Z");
const EXPIRES_IN_MS = 252_000; // 4:12

const READY: DisplayState = {
  runtime: RuntimeState.Ready,
  error: null,
  reconnecting: false,
  busy: false,
  link: { ...IDLE_LINK, registration: "up", websocket: "up", microphone: "ok" },
  details: {
    ...EMPTY_DETAILS,
    account: "1005",
    domain: "ws.aicc.test",
    registrationExpiresAt: NOW + EXPIRES_IN_MS,
    turnConfigured: false,
    micDeviceLabel: "MacBook Pro Microphone",
    // Mid-scale: enough to light the meter without pinning it, which is what a person
    // talking normally looks like.
    micLevel: 0.14
  }
};

const STATES: Record<string, { state: DisplayState; open: boolean }> = {
  ready: { state: READY, open: false },
  panel: { state: READY, open: true },
  // A call rides the button, never the badge — the whole point of the two-channel design.
  call: { state: { ...READY, busy: true, link: { ...READY.link, media: "ok" } }, open: false }
};

const which = new URL(location.href).searchParams.get("state") ?? "ready";
const shot = STATES[which];
if (!shot) {
  throw new Error(`Unknown preview state "${which}" — expected one of ${Object.keys(STATES).join(", ")}`);
}

const host = document.createElement("div");
host.id = "web-sip-phone-host";
document.documentElement.appendChild(host);

const view = new WebSipPhoneView(host, () => {}, { version: __VERSION__, now: () => NOW });
applyPosition(host, null); // the default dock, top-right
view.update(shot.state);
if (shot.open) {
  view.dot.click();
}

// The shoot waits for this rather than a fixed delay, so a slow font load cannot land
// mid-render in the PNG.
document.fonts.ready.then(() => {
  document.documentElement.setAttribute("data-preview-ready", which);
});
