// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { IDLE_LINK, RuntimeState, type DisplayState } from "../../src/shared/state.js";
import { WebSipPhoneView, type UiIntent } from "../../src/content/view.js";

const READY: DisplayState = {
  runtime: RuntimeState.Ready,
  error: null,
  reconnecting: false,
  busy: false,
  link: { registration: "up", websocket: "up", microphone: "ok", media: "idle" }
};

let host: HTMLElement;
let intents: UiIntent[];
let view: WebSipPhoneView;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  intents = [];
  view = new WebSipPhoneView(host, (i) => intents.push(i));
});

const root = () => host.shadowRoot!;

describe("collapsed dot", () => {
  it("stays collapsed in READY with no error card", () => {
    view.update(READY);
    expect(root().querySelector("[data-role=dot]")).toBeTruthy();
    expect(root().querySelector("[data-role=error-card]")).toBeNull();
  });
  it("never renders call info or controls", () => {
    view.update(READY);
    const text = root().textContent ?? "";
    for (const forbidden of ["Answer", "Hangup", "Hold", "Resume", "Mute", "DTMF"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("error auto-expand", () => {
  it("expands with exact copy and routes the action intent", () => {
    view.update({ ...READY, runtime: RuntimeState.RegistrationFailed, error: "REGISTRATION_FAILED" });
    const card = root().querySelector("[data-role=error-card]")!;
    expect(card.textContent).toContain("Registration failed");
    expect(card.textContent).toContain("Check account settings");
    const btn = card.querySelector("button[data-role=error-action]") as HTMLButtonElement;
    expect(btn.textContent).toBe("Open Settings");
    btn.click();
    expect(intents).toEqual([{ kind: "openOptions", section: "account" }]);
  });

  it("CONNECTION_LOST offers Retry", () => {
    view.update({ ...READY, runtime: RuntimeState.ConnectionLost, error: "CONNECTION_LOST" });
    const btn = root().querySelector("button[data-role=error-action]") as HTMLButtonElement;
    expect(btn.textContent).toBe("Retry");
    btn.click();
    expect(intents).toEqual([{ kind: "retry" }]);
  });

  it("collapses again when the error clears", () => {
    view.update({ ...READY, runtime: RuntimeState.MediaFailed, error: "MEDIA_FAILED" });
    expect(root().querySelector("[data-role=error-card]")).toBeTruthy();
    view.update(READY);
    expect(root().querySelector("[data-role=error-card]")).toBeNull();
  });
});

describe("voice connection panel", () => {
  it("opens on dot click with the four link rows and no call controls", () => {
    view.update(READY);
    (root().querySelector("[data-role=dot]") as HTMLElement).click();
    const panel = root().querySelector("[data-role=panel]")!;
    for (const row of ["SIP Registration", "WebSocket", "Microphone", "Media"]) {
      expect(panel.textContent).toContain(row);
    }
    expect(panel.querySelectorAll("button[data-role=call-control]").length).toBe(0);
  });
  it("close button hides the panel", () => {
    view.update(READY);
    (root().querySelector("[data-role=dot]") as HTMLElement).click();
    (root().querySelector("[data-role=panel-close]") as HTMLElement).click();
    expect(root().querySelector("[data-role=panel]")).toBeNull();
  });
});

describe("panelOpen does not leak across the error boundary", () => {
  it("dot click while an error card is shown does not open the panel after the error clears", () => {
    view.update({ ...READY, runtime: RuntimeState.RegistrationFailed, error: "REGISTRATION_FAILED" });
    (root().querySelector("[data-role=dot]") as HTMLElement).click();
    view.update(READY);
    expect(root().querySelector("[data-role=panel]")).toBeNull();
  });

  it("panel open when an error arrives is closed after the error clears", () => {
    view.update(READY);
    (root().querySelector("[data-role=dot]") as HTMLElement).click();
    view.update({ ...READY, runtime: RuntimeState.MediaFailed, error: "MEDIA_FAILED" });
    view.update(READY);
    expect(root().querySelector("[data-role=panel]")).toBeNull();
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

  it("shows the desk-phone icon on a plain white button when idle", () => {
    view.update(READY);
    expect(button().className).not.toContain("in-call");
    expect(button().querySelector("svg.icon-idle")).toBeTruthy();
    expect(button().querySelector("svg.icon-call")).toBeTruthy();
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
    expect(button().getAttribute("aria-label")).toContain("Ready");
  });
});

describe("reconnecting", () => {
  it("shows Reconnecting… in the aria label without expanding", () => {
    view.update({ ...READY, reconnecting: true });
    const dot = root().querySelector("[data-role=dot]") as HTMLElement;
    expect(dot.getAttribute("aria-label")).toContain("Reconnecting…");
    expect(root().querySelector("[data-role=error-card]")).toBeNull();
  });
});
