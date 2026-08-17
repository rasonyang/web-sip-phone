// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DETAILS, IDLE_LINK, RuntimeState, type DisplayState } from "../../src/shared/state.js";
import { WebSipPhoneView, type UiIntent } from "../../src/content/view.js";

const NOW = 1_770_000_000_000;

const READY: DisplayState = {
  runtime: RuntimeState.Ready,
  error: null,
  reconnecting: false,
  busy: false,
  link: { registration: "up", websocket: "up", microphone: "ok", media: "idle" },
  details: {
    ...EMPTY_DETAILS,
    account: "1001",
    domain: "voice.example.com",
    registrationExpiresAt: NOW + 252_000, // 4:12
    micDeviceLabel: "Studio Mic"
  }
};

let host: HTMLElement;
let intents: UiIntent[];
let view: WebSipPhoneView;
let clipboard: string[];
let copyFails: boolean;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  intents = [];
  clipboard = [];
  copyFails = false;
  view = new WebSipPhoneView(host, (i) => intents.push(i), {
    version: "1.0.2",
    now: () => NOW,
    writeClipboard: async (text) => {
      if (copyFails) {
        throw new Error("denied");
      }
      clipboard.push(text);
    }
  });
});

const root = () => host.shadowRoot!;
const panel = () => root().querySelector("[data-role=panel]");
const openPanel = () => (root().querySelector("[data-role=dot]") as HTMLElement).click();
const identity = () => root().querySelector("[data-role=identity-rows]");
const rowText = (key: string) => identity()?.querySelector(`[data-role=row-${key}]`)?.textContent ?? "";
const fault = (code: DisplayState["error"], runtime: RuntimeState, extra: Partial<DisplayState> = {}) =>
  view.update({ ...READY, runtime, error: code, ...extra });

describe("collapsed dot", () => {
  it("stays collapsed in READY with no panel", () => {
    view.update(READY);
    expect(root().querySelector("[data-role=dot]")).toBeTruthy();
    expect(panel()).toBeNull();
  });
  it("never renders call info or controls", () => {
    view.update(READY);
    openPanel();
    const text = root().textContent ?? "";
    for (const forbidden of ["Answer", "Hangup", "Hold", "Resume", "Mute", "DTMF"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("healthy panel: identity and risk", () => {
  beforeEach(() => {
    view.update(READY);
    openPanel();
  });

  it("leads with the extension identity, never a credential", () => {
    expect(rowText("extension")).toContain("1001 @ voice.example.com");
    expect(panel()!.textContent).not.toContain("pw");
  });

  it("merges registration and WebSocket into one Signaling row with an expiry countdown", () => {
    expect(rowText("signaling")).toContain("WSS");
    expect(rowText("signaling")).toContain("expires in 4:12");
    // The two raw signals are no longer separate headline rows.
    expect(identity()!.querySelector("[data-role=detail-sip-registration]")).toBeNull();
    expect(identity()!.querySelector("[data-role=row-websocket]")).toBeNull();
  });

  it("names the microphone device and shows a live level meter", () => {
    expect(rowText("microphone")).toContain("Studio Mic");
    expect(panel()!.querySelector("[data-role=mic-meter]")).toBeTruthy();
  });

  it("drops the constant Idle media row from the headline view", () => {
    expect(identity()!.querySelector("[data-role=row-media]")).toBeNull();
  });

  it("keeps TURN as a one-word risk flag, with the consequence in the details", () => {
    expect(rowText("turn")).toBe("TURNNot configured");
    expect(identity()!.querySelector("[data-role=row-turn] .ind")!.className).toContain("ind-warn");
    (root().querySelector("[data-role=details-toggle]") as HTMLElement).click();
    expect(root().querySelector("[data-role=detail-turn]")!.textContent).toContain(
      "calls may fail on restricted networks"
    );
  });

  it("reports a configured TURN server as a settled risk", () => {
    view.update({ ...READY, details: { ...READY.details, turnConfigured: true } });
    expect(rowText("turn")).toContain("Configured");
    expect(identity()!.querySelector("[data-role=row-turn] .ind")!.className).toContain("ind-ok");
  });

  it("carries shape as a second channel next to colour", () => {
    for (const el of root().querySelectorAll(".ind[role=img]")) {
      expect(el.querySelector("svg")).toBeTruthy();
      expect(el.getAttribute("aria-label")).toBeTruthy();
    }
  });
});

describe("raw-signal disclosure", () => {
  const details = () => root().querySelector("[data-role=details]");
  const toggle = () => root().querySelector("[data-role=details-toggle]") as HTMLElement;

  it("hangs off the Signaling row and is collapsed by default", () => {
    view.update(READY);
    openPanel();
    expect(details()).toBeNull();
    expect(identity()!.querySelector("[data-role=row-signaling] [data-role=details-toggle]")).toBeTruthy();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the four raw signals plus TURN", () => {
    view.update(READY);
    openPanel();
    toggle().click();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const text = details()!.textContent ?? "";
    for (const row of ["SIP registration", "WebSocket", "Microphone", "Media", "TURN"]) {
      expect(text).toContain(row);
    }
    for (const value of ["Registered", "Connected", "Ready", "Idle"]) {
      expect(text).toContain(value);
    }
  });

  it("humanizes degraded raw signals", () => {
    view.update({
      ...READY,
      runtime: RuntimeState.Connecting,
      link: { registration: "down", websocket: "connecting", microphone: "blocked", media: "failed" }
    });
    openPanel();
    toggle().click();
    const text = details()?.textContent ?? "";
    for (const value of ["Not registered", "Connecting", "Blocked", "Failed"]) {
      expect(text).toContain(value);
    }
  });

  it("survives a re-render once opened", () => {
    view.update(READY);
    openPanel();
    toggle().click();
    view.update({ ...READY, busy: true });
    expect(details()).toBeTruthy();
  });
});

describe("fault state", () => {
  it("auto-expands and replaces the Signaling row with imperative, reasoned copy", () => {
    fault("REGISTRATION_FAILED", RuntimeState.RegistrationFailed, {
      details: { ...READY.details, lastError: { code: "REGISTRATION_FAILED", reasonPhrase: "403 Forbidden" } }
    });
    const row = identity()!.querySelector("[data-role=row-signaling]")!;
    expect(row.className).toContain("fault");
    expect(row.textContent).toContain("Registration failed (403 Forbidden)");
    expect(row.textContent).toContain("check password in Settings");
    expect(row.querySelector(".ind")!.className).toContain("ind-err");
  });

  it("keeps exactly one emphasised action, in the footer, and routes its intent", () => {
    fault("REGISTRATION_FAILED", RuntimeState.RegistrationFailed);
    const primaries = root().querySelectorAll("button.primary");
    expect(primaries.length).toBe(1);
    expect(primaries[0].textContent).toBe("Retry now");
    // The faulted row states what broke; it does not repeat the action.
    expect(identity()!.querySelector("[data-role=row-signaling] button")).toBeNull();
    (primaries[0] as HTMLButtonElement).click();
    expect(intents).toContainEqual({ kind: "retry" });
    // Settings stays one tap away, since that is where the copy sends the user.
    expect(root().querySelector("[data-role=act-settings]")).toBeTruthy();
  });

  it("counts down to the next retry while backing off", () => {
    fault("CONNECTION_LOST", RuntimeState.ConnectionLost, {
      details: { ...READY.details, reconnect: { attempt: 3, nextAttemptAt: NOW + 12_000 } }
    });
    const row = identity()!.querySelector("[data-role=row-signaling]")!;
    expect(row.textContent).toContain("Voice server unreachable");
    expect(row.textContent).toContain("Retrying in 0:12 · attempt 3");
    (root().querySelector("[data-role=act-primary]") as HTMLButtonElement).click();
    expect(intents).toContainEqual({ kind: "retry" });
  });

  it("faults the microphone row, leaving the rest of the context on screen", () => {
    fault("MICROPHONE_BLOCKED", RuntimeState.MicrophoneBlocked);
    expect(rowText("microphone")).toContain("Microphone blocked");
    expect(rowText("extension")).toContain("1001 @ voice.example.com");
    expect(root().querySelector("[data-role=act-primary]")!.textContent).toBe("Enable microphone");
  });

  it("adds a Call audio row for a media fault and points at TURN", () => {
    fault("MEDIA_FAILED", RuntimeState.MediaFailed, {
      details: { ...READY.details, lastError: { code: "MEDIA_FAILED", reasonPhrase: "ICE connection failed" } }
    });
    expect(rowText("media")).toContain("Call audio failed (ICE connection failed)");
    expect(root().querySelector("[data-role=act-primary]")!.textContent).toBe("Configure TURN");
  });

  it("collapses again when the fault clears", () => {
    fault("MEDIA_FAILED", RuntimeState.MediaFailed);
    expect(panel()).toBeTruthy();
    view.update(READY);
    expect(panel()).toBeNull();
  });

  it("keeps the fault panel open against a dot click", () => {
    fault("REGISTRATION_FAILED", RuntimeState.RegistrationFailed);
    openPanel();
    expect(panel()).toBeTruthy();
    view.update(READY);
    expect(panel()).toBeNull();
  });
});

describe("footer actions", () => {
  beforeEach(() => {
    view.update(READY);
    openPanel();
  });

  const act = (role: string) => root().querySelector(`[data-role=${role}]`) as HTMLButtonElement;

  it("offers Reconnect, Test microphone, Copy diagnostics, Settings and the version", () => {
    expect(act("act-reconnect").textContent).toBe("Reconnect");
    expect(act("act-test-mic").textContent).toBe("Test microphone");
    expect(act("act-copy").textContent).toBe("Copy diagnostics");
    expect(act("act-settings").textContent).toBe("Settings");
    expect(root().querySelector("[data-role=version]")!.textContent).toBe("v1.0.2");
  });

  it("routes Reconnect and Settings", () => {
    act("act-reconnect").click();
    expect(intents).toContainEqual({ kind: "retry" });
    act("act-settings").click();
    expect(intents).toContainEqual({ kind: "openOptions", section: "account" });
  });

  it("delegates the microphone test rather than touching the microphone itself", () => {
    act("act-test-mic").click();
    expect(intents).toContainEqual({ kind: "testMic" });
    expect(act("act-test-mic").textContent).toBe("Testing…");
    // The verdict rides the next status broadcast, not a reply.
    view.update(READY);
    expect(act("act-test-mic").textContent).toBe("Microphone OK");
  });

  it("sends a blocked verdict on to the Options page, which is the only place that can prompt", () => {
    act("act-test-mic").click();
    view.update({ ...READY, link: { ...READY.link, microphone: "blocked" } });
    expect(act("act-test-mic").textContent).toBe("Microphone blocked");
    expect(intents).toContainEqual({ kind: "micBlocked" });
  });

  it("copies diagnostics with no credential in them", async () => {
    act("act-copy").click();
    await vi.waitFor(() => expect(clipboard.length).toBe(1));
    const text = clipboard[0];
    expect(text).toContain("Web SIP Phone 1.0.2");
    expect(text).toContain("1001 @ voice.example.com");
    expect(text).toContain("SIP registration: up");
    expect(text).toContain("TURN: not configured");
    expect(text.toLowerCase()).not.toContain("password:");
    expect(text).toContain("Credentials: not included");
    expect(act("act-copy").textContent).toBe("Copied");
  });

  it("says so when the clipboard refuses", async () => {
    copyFails = true;
    act("act-copy").click();
    await vi.waitFor(() => expect(act("act-copy").textContent).toBe("Copy failed"));
  });
});

describe("panel expansion drives metering", () => {
  it("reports open and closed exactly once per transition", () => {
    view.update(READY);
    expect(intents).toEqual([]);
    openPanel();
    expect(intents).toEqual([{ kind: "panelState", open: true }]);
    view.update({ ...READY, busy: true }); // a re-render is not a transition
    expect(intents).toEqual([{ kind: "panelState", open: true }]);
    openPanel();
    expect(intents).toEqual([
      { kind: "panelState", open: true },
      { kind: "panelState", open: false }
    ]);
  });

  it("reports the auto-expand caused by a fault", () => {
    view.update(READY);
    fault("CONNECTION_LOST", RuntimeState.ConnectionLost);
    expect(intents).toContainEqual({ kind: "panelState", open: true });
  });

  it("lights the meter bars from the broadcast level", () => {
    view.update({ ...READY, details: { ...READY.details, micLevel: 0.5 } });
    openPanel();
    const lit = () => [...root().querySelectorAll("[data-role=mic-meter] .bar")].filter((b) => b.className.includes("on")).length;
    expect(lit()).toBe(4);
    view.setMicLevel(0.05);
    expect(lit()).toBe(2);
    view.setMicLevel(0);
    expect(lit()).toBe(0);
  });
});

describe("panel placement and dismissal", () => {
  it("opens toward the middle of the viewport", () => {
    view.update(READY);
    const dot = root().querySelector("[data-role=dot]") as HTMLElement;
    const wrap = () => root().querySelector(".wrap") as HTMLElement;
    // Parked top-left (jsdom reports a zero rect) → the card drops down and to the right.
    dot.click();
    expect(wrap().className).toBe("wrap card-below card-left");
    dot.click();
    // Parked bottom-right → the card rises and hangs off the dot's right edge.
    dot.getBoundingClientRect = () => ({ top: 700, left: 900, width: 36, height: 36 }) as DOMRect;
    dot.click();
    expect(wrap().className).toBe("wrap card-above card-right");
  });

  it("clicking outside the widget dismisses the panel", () => {
    view.update(READY);
    openPanel();
    // jsdom has no PointerEvent constructor; the listener only reads type and target.
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel()).toBeNull();
  });

  it("Escape dismisses the panel", () => {
    view.update(READY);
    openPanel();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel()).toBeNull();
  });

  it("a pointerdown on the widget itself leaves the panel open", () => {
    view.update(READY);
    openPanel();
    host.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel()).toBeTruthy();
  });
});

describe("panelOpen does not leak across the error boundary", () => {
  it("dot click while a fault is shown does not open the panel after it clears", () => {
    fault("REGISTRATION_FAILED", RuntimeState.RegistrationFailed);
    openPanel();
    view.update(READY);
    expect(panel()).toBeNull();
  });

  it("panel open when a fault arrives is closed after the fault clears", () => {
    view.update(READY);
    openPanel();
    fault("MEDIA_FAILED", RuntimeState.MediaFailed);
    view.update(READY);
    expect(panel()).toBeNull();
  });
});

describe("connection dot (health channel)", () => {
  const statusDot = () => root().querySelector("[data-role=status-dot]") as HTMLElement;

  it("shows green when registered and idle", () => {
    view.update(READY);
    expect(statusDot().className).toContain("status-ok");
  });

  it("stays green during a call — call activity never touches the dot", () => {
    view.update({ ...READY, busy: true });
    expect(statusDot().className).toContain("status-ok");
    expect(statusDot().className).not.toContain("status-warn");
  });

  it("shows red when not connected", () => {
    view.update({ ...READY, runtime: RuntimeState.InactiveNoAllowedSite });
    expect(statusDot().className).toContain("status-err");
  });

  it("shows pulsing amber while connecting (never red, which reads as failure)", () => {
    view.update({ ...READY, runtime: RuntimeState.Connecting });
    expect(statusDot().className).toContain("status-warn");
    expect(statusDot().className).toContain("status-pulse");
    expect(statusDot().className).not.toContain("status-err");
  });
});

describe("call activity (button channel)", () => {
  const button = () => root().querySelector("[data-role=dot]") as HTMLElement;

  it("shows the headset icon on a plain button when idle", () => {
    view.update(READY);
    expect(button().className).not.toContain("in-call");
    expect(button().querySelector("svg")).toBeTruthy();
  });

  it("switches to the in-call style during a call and labels it", () => {
    view.update({ ...READY, busy: true });
    expect(button().className).toContain("in-call");
    expect(button().getAttribute("aria-label")).toContain("On a call");
  });

  it("keeps the in-call style while reconnecting mid-call, with both facts in the label", () => {
    view.update({ ...READY, busy: true, reconnecting: true });
    expect(button().className).toContain("in-call");
    const label = button().getAttribute("aria-label") ?? "";
    expect(label).toContain("Reconnecting…");
    expect(label).toContain("On a call");
  });

  it("returns to idle style when the call ends", () => {
    view.update({ ...READY, busy: true });
    view.update(READY);
    expect(button().className).not.toContain("in-call");
    expect(button().getAttribute("aria-label")).toContain("Voice ready");
  });
});

describe("reconnecting", () => {
  it("shows Reconnecting… in the aria label without expanding", () => {
    view.update({ ...READY, reconnecting: true });
    const dot = root().querySelector("[data-role=dot]") as HTMLElement;
    expect(dot.getAttribute("aria-label")).toContain("Reconnecting…");
    expect(panel()).toBeNull();
  });

  it("shows the retry countdown in the Signaling row when opened mid-backoff", () => {
    view.update({
      ...READY,
      reconnecting: true,
      link: { ...IDLE_LINK, microphone: "ok" },
      details: { ...READY.details, reconnect: { attempt: 2, nextAttemptAt: NOW + 8000 } }
    });
    openPanel();
    expect(rowText("signaling")).toContain("WSS · reconnecting");
    expect(rowText("signaling")).toContain("retrying in 0:08 · attempt 2");
  });
});
