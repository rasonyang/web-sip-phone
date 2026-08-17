import { RuntimeState, type DisplayState, type ErrorCode, type LinkStatus } from "../shared/state.js";
import { buildDiagnostics, formatDuration } from "./diagnostics.js";

export type UiIntent =
  | { kind: "openOptions"; section: "account" | "sites" | "advanced" }
  | { kind: "retry" }
  | { kind: "testMic" }
  /** The microphone test came back blocked; only the Options page can prompt for access. */
  | { kind: "micBlocked" }
  /** The panel's expansion drives microphone metering in the offscreen document. */
  | { kind: "panelState"; open: boolean };

export interface ViewEnv {
  /** Extension version, shown in the panel footer and in copied diagnostics. */
  version: string;
  now?: () => number;
  /** Injected for tests; the real one is `navigator.clipboard.writeText`. */
  writeClipboard?: (text: string) => Promise<void>;
}

/**
 * The four connection-level faults, each rendered *in the row it belongs to* rather than as a
 * separate error card: a fault is a property of one signal, and showing it in place keeps the
 * rest of the identity context on screen while it is broken. Copy is imperative and names the
 * server's own reason — a bare "Registration failed" leaves the user guessing between a typo'd
 * password and an unreachable server.
 */
export const FAULT_COPY: Record<
  ErrorCode,
  { message: (reason: string) => string; action: string; intent: UiIntent }
> = {
  MICROPHONE_BLOCKED: {
    message: () => "Microphone blocked — allow access in Settings",
    action: "Enable microphone",
    intent: { kind: "openOptions", section: "advanced" }
  },
  MEDIA_FAILED: {
    message: (reason) => `Call audio failed${reason ? ` (${reason})` : ""} — configure a TURN server`,
    action: "Configure TURN",
    intent: { kind: "openOptions", section: "advanced" }
  },
  REGISTRATION_FAILED: {
    // The status code earns its place: it is the difference between "you typed the password
    // wrong" (403) and "the server has no idea who you are" (404), and the user cannot act
    // without it. The Settings entry point is one tap away in the footer.
    message: (reason) => `Registration failed${reason ? ` (${reason})` : ""} — check password in Settings`,
    action: "Retry now",
    intent: { kind: "retry" }
  },
  CONNECTION_LOST: {
    message: () => "Voice server unreachable — check the network connection",
    action: "Retry now",
    intent: { kind: "retry" }
  }
};

// Tokens copied from the host application's design system (ui-test web/src/index.css) so the
// widget reads as part of the shell rather than an add-on. State colors are semantic there:
// available/oncall/ringing/breach/offline, which is why "on a call" gets its own hue instead
// of overloading the amber used for transitional states.
const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: "Inter Variable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
/* The wrap is exactly the dot: the widget is dragged freely on both axes, so its host box must
   stay a fixed 36px square regardless of whether a panel is open. The panel floats out of flow. */
.wrap {
  position: relative; width: 36px; height: 36px;
  --card: #fff; --foreground: #18181b; --muted-foreground: #71717a; --border: #e5e7eb;
  --state-available: #16a34a; --state-oncall: #4f46e5; --state-ringing: #f59e0b;
  --state-breach: #dc2626; --state-offline: #d4d4d8;
}
.dot {
  position: relative; width: 36px; height: 36px; border-radius: 9999px;
  border: 1px solid var(--border); background: var(--card); color: var(--muted-foreground);
  box-shadow: 0 1px 2px rgba(0,0,0,.05);
  cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0;
}
.dot:hover { background: #f4f4f5; }
.dot:focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; }
.dot svg { width: 16px; height: 16px; display: block; pointer-events: none; }
/* Call activity rides the button; the status dot stays a pure connection-health signal. */
.dot.in-call { background: #eef2ff; border-color: #c7d2fe; color: var(--state-oncall); }
.dot.in-call:hover { background: #e0e7ff; }
.status {
  position: absolute; top: 1px; right: 1px; width: 8px; height: 8px;
  border-radius: 9999px; border: 1px solid var(--card); pointer-events: none;
}
.status-ok { background: var(--state-available); }
.status-warn { background: var(--state-ringing); }
.status-err { background: var(--state-breach); }
.status-pulse { animation: wsp-pulse 1.2s ease-in-out infinite; }
@keyframes wsp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.card {
  position: absolute; background: var(--card); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,.08), 0 2px 4px rgba(0,0,0,.04);
  width: 312px; color: var(--foreground); overflow: hidden;
}
/* The panel opens toward the middle of the viewport so it never lands off screen. */
.wrap.card-below .card { top: 42px; }
.wrap.card-above .card { bottom: 42px; }
.wrap.card-left .card { left: 0; }
.wrap.card-right .card { right: 0; }
.panel-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; gap: 8px; }
.panel-head .title { font-size: 14px; font-weight: 500; white-space: nowrap; }
.panel-head .overall { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; }
/* The headline status carries the state colour: it is the one line read at a glance. */
.overall.state-ok { color: var(--state-available); }
.overall.state-warn { color: var(--state-ringing); }
.overall.state-err { color: var(--state-breach); }
.sep { height: 1px; background: var(--border); }
.rows { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; }
/* Fixed label and status columns: every shape lands on the same vertical line, so the panel
   can be scanned down the indicators alone instead of hunting ragged right-aligned values. */
.row { display: grid; grid-template-columns: 84px 14px 1fr; align-items: start; gap: 8px; font-size: 13px; }
.row .label { color: var(--muted-foreground); }
.row .val { color: var(--foreground); overflow-wrap: anywhere; min-width: 0; }
/* A value that ends in an affordance keeps it on the same line: the chevron never shrinks,
   the text yields instead. Without min-width:0 the text refuses to shrink and the affordance
   wraps to a line of its own, where it reads as a stray character. */
.val-inline { display: flex; align-items: center; gap: 4px; min-width: 0; }
.val-inline .text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.val-inline .chev, .val-inline .meter { flex: none; }
/* A faulted row is banded, not just recoloured: it has to be findable without reading. */
.row.fault {
  background: #fef2f2; color: var(--state-breach);
  padding: 8px 16px; margin: -2px -16px; align-items: start;
}
.row.fault .label, .row.fault .val { color: var(--state-breach); }
.row.fault .val .headline { font-weight: 500; }
.row.fault .val .retry { font-size: 12px; margin-top: 2px; }
.ind { width: 14px; height: 14px; display: block; margin-top: 1px; }
.ind svg { width: 14px; height: 14px; display: block; }
.ind-ok { color: var(--state-available); }
.ind-warn { color: var(--state-ringing); }
.ind-err { color: var(--state-breach); }
.ind-idle { color: var(--state-offline); }
.ind-pulse { animation: wsp-pulse 1.2s ease-in-out infinite; }
.mic-row { display: flex; align-items: center; gap: 8px; justify-content: space-between; min-width: 0; }
/* The device name is long and rarely fully load-bearing; the meter next to it is the answer
   to "is this microphone actually hearing me", so the name yields the space. */
.mic-row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.meter { flex: none; display: flex; align-items: flex-end; gap: 2px; height: 14px; }
.meter .bar { width: 3px; border-radius: 1px; background: #e4e4e7; }
.meter .bar.on { background: var(--state-available); }
.meter .bar:nth-child(1) { height: 5px; }
.meter .bar:nth-child(2) { height: 8px; }
.meter .bar:nth-child(3) { height: 11px; }
.meter .bar:nth-child(4) { height: 14px; }
.muted { color: var(--muted-foreground); }
/* The raw signals hang off the row they explain, rather than a separate "Details" line. */
button.chev {
  border: none; background: none; padding: 0; cursor: pointer; line-height: 1;
  color: var(--muted-foreground); font-size: 14px;
}
button.chev:hover { color: var(--foreground); }
.detail-rows { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 0; font-size: 12px; }
.detail-rows .row { grid-template-columns: 84px 14px 1fr; font-size: 12px; }
.panel-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 10px 16px 12px; }
.panel-foot .version { margin-left: auto; font-size: 11px; color: var(--muted-foreground); }
button.action {
  font-size: 13px; font-weight: 500; border: 1px solid var(--border); background: var(--card);
  border-radius: 6px; padding: 6px 12px; cursor: pointer; color: var(--foreground);
}
button.action:hover { background: #f4f4f5; }
/* Exactly one primary action is ever on screen: the recovery step for the current fault. */
button.action.primary { background: var(--foreground); border-color: var(--foreground); color: #fff; }
button.action.primary:hover { background: #27272a; }
button.link {
  font-size: 13px; border: none; background: none; padding: 0; cursor: pointer;
  color: #2563eb; text-decoration: none;
}
button.link:hover { text-decoration: underline; }
/* Exactly one action is ever emphasised: the recovery step for the current fault. */
button.link.primary { font-weight: 600; }
`;

// lucide "headset" (24px grid, stroke 2, round caps) — the host application uses the same
// icon for its voice terminal affordance.
const HEADSET_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5a9 9 0 0 1 18 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>
  <path d="M21 16v2a4 4 0 0 1-4 4h-5"/>
</svg>`;

// Shape is a second channel alongside colour (lucide check / triangle-alert / x), so the panel
// stays readable for colour-blind users and in a screenshot pasted into a support ticket.
const SHAPE_ICONS: Record<Health, string> = {
  ok: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  err: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>`
};

/** Speech lights the low bars constantly; the top bar is reserved for a genuinely loud room. */
const METER_THRESHOLDS = [0.01, 0.04, 0.12, 0.3];

type Health = "ok" | "warn" | "err" | "idle";
const HEALTH_LABEL: Record<Health, string> = { ok: "OK", warn: "Warning", err: "Failed", idle: "Idle" };

// Connection health only — call activity never changes the dot.
type DotView = { cls: "status-ok" | "status-warn" | "status-err"; pulse: boolean };

function dotFor(state: DisplayState): DotView {
  if (state.error) {
    return { cls: "status-err", pulse: false };
  }
  // Amber pulse = transitional (connecting/reconnecting); solid red is reserved for
  // hard failure states so a blink is never mistaken for "failed".
  if (state.reconnecting) {
    return { cls: "status-warn", pulse: true };
  }
  switch (state.runtime) {
    case RuntimeState.Ready:
      return { cls: "status-ok", pulse: false };
    case RuntimeState.Connecting:
    case RuntimeState.Registering:
      return { cls: "status-warn", pulse: true };
    default:
      return { cls: "status-err", pulse: false };
  }
}

function labelFor(state: DisplayState): string {
  if (state.error) {
    return FAULT_TITLE[state.error];
  }
  if (state.reconnecting) {
    return state.busy ? "Reconnecting… — On a call" : "Reconnecting…";
  }
  switch (state.runtime) {
    case RuntimeState.Ready:
      return state.busy ? "On a call" : "Voice ready";
    case RuntimeState.Connecting:
    case RuntimeState.Registering:
      return "Connecting…";
    default:
      return "Not connected";
  }
}

const FAULT_TITLE: Record<ErrorCode, string> = {
  MICROPHONE_BLOCKED: "Microphone unavailable",
  MEDIA_FAILED: "Call audio failed",
  REGISTRATION_FAILED: "Registration failed",
  CONNECTION_LOST: "Voice connection lost"
};

/** Raw signals, kept behind Details: protocol truth for a support ticket, not the headline. */
const DETAIL_ROWS: Array<{ label: string; value: (l: LinkStatus) => { text: string; health: Health } }> = [
  {
    label: "SIP registration",
    value: (l) =>
      l.registration === "up"
        ? { text: "Registered", health: "ok" }
        : l.registration === "connecting"
          ? { text: "Connecting", health: "warn" }
          : { text: "Not registered", health: "err" }
  },
  {
    label: "WebSocket",
    value: (l) =>
      l.websocket === "up"
        ? { text: "Connected", health: "ok" }
        : l.websocket === "connecting"
          ? { text: "Connecting", health: "warn" }
          : { text: "Disconnected", health: "err" }
  },
  {
    label: "Microphone",
    value: (l) =>
      l.microphone === "ok"
        ? { text: "Ready", health: "ok" }
        : l.microphone === "blocked"
          ? { text: "Blocked", health: "err" }
          : { text: "Unknown", health: "idle" }
  },
  {
    label: "Media",
    value: (l) =>
      l.media === "ok"
        ? { text: "Active", health: "ok" }
        : l.media === "failed"
          ? { text: "Failed", health: "err" }
          : { text: "Idle", health: "ok" }
  }
];

function indicator(health: Health, pulse = false): HTMLElement {
  const el = document.createElement("span");
  el.className = `ind ind-${health}${pulse ? " ind-pulse" : ""}`;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", HEALTH_LABEL[health]);
  el.innerHTML = SHAPE_ICONS[health];
  return el;
}

export class WebSipPhoneView {
  readonly dot: HTMLElement;
  private shadow: ShadowRoot;
  private wrap: HTMLElement;
  private statusDot: HTMLElement;
  private state: DisplayState | null = null;
  private panelOpen = false;
  private detailsOpen = false;
  private expanded = false;
  private now: () => number;
  private writeClipboard: (text: string) => Promise<void>;
  /** Text nodes whose content is a live countdown, refreshed by the 1s tick while expanded. */
  private tickers: Array<{ el: HTMLElement; text: (now: number) => string }> = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private meterBars: HTMLElement[] = [];
  private copyStatus: string | null = null;
  private micStatus: string | null = null;
  private micTestPending = false;
  /** Kept across re-renders so a redrawn meter is not blank until the next 100ms tick. */
  private lastMicLevel = 0;
  private micStatusTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private host: HTMLElement,
    private onIntent: (intent: UiIntent) => void,
    private env: ViewEnv = { version: "" }
  ) {
    this.now = env.now ?? (() => Date.now());
    this.writeClipboard = env.writeClipboard ?? ((text) => navigator.clipboard.writeText(text));
    this.shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.shadow.appendChild(style);
    this.wrap = document.createElement("div");
    this.wrap.className = "wrap";
    this.shadow.appendChild(this.wrap);
    this.dot = document.createElement("button");
    this.dot.className = "dot";
    this.dot.setAttribute("data-role", "dot");
    this.dot.innerHTML = HEADSET_ICON;
    this.statusDot = document.createElement("span");
    this.statusDot.className = "status status-err";
    this.statusDot.setAttribute("data-role", "status-dot");
    this.dot.appendChild(this.statusDot);
    this.dot.addEventListener("click", () => {
      if (this.state?.error) {
        return; // a fault holds the panel open; it is dismissed by fixing it, not by clicking
      }
      this.panelOpen = !this.panelOpen;
      this.render();
    });

    // Popover dismissal: the panel has no close button (matching the host application), so
    // clicking away or pressing Escape must close it. Events outside the shadow root retarget
    // to the host element, so containment covers clicks on the widget itself.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (this.panelOpen && !host.contains(e.target as Node)) {
          this.panelOpen = false;
          this.render();
        }
      },
      true
    );
    document.addEventListener("keydown", (e) => {
      if (this.panelOpen && e.key === "Escape") {
        this.panelOpen = false;
        this.render();
      }
    });
  }

  update(state: DisplayState): void {
    this.state = state;
    if (state.error) {
      this.panelOpen = false; // auto-expand owns the panel while a fault is up
    }
    if (this.micTestPending) {
      // The offscreen test reports through the normal status broadcast rather than a reply,
      // so the first state to arrive after the request carries its verdict.
      this.micTestPending = false;
      this.reportMicTest(state.link.microphone === "ok");
      return; // reportMicTest renders
    }
    this.render();
  }

  /** Live level tick from the offscreen meter; lights the bars without a re-render. */
  setMicLevel(level: number): void {
    this.lastMicLevel = level;
    this.meterBars.forEach((bar, i) => {
      bar.classList.toggle("on", level >= METER_THRESHOLDS[i]);
    });
  }

  private isExpanded(): boolean {
    return this.state !== null && (this.state.error !== null || this.panelOpen);
  }

  private render(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    this.tickers = [];
    this.meterBars = [];
    this.wrap.replaceChildren();

    const expanded = this.isExpanded();
    if (expanded) {
      this.wrap.className = `wrap ${this.cardPlacement()}`;
      this.wrap.appendChild(this.panel(state));
    }

    const { cls, pulse } = dotFor(state);
    const label = labelFor(state);
    this.statusDot.className = `status ${cls}${pulse ? " status-pulse" : ""}`;
    this.dot.className = `dot${state.busy ? " in-call" : ""}`;
    this.dot.setAttribute("aria-label", `Web SIP Phone status: ${label}`);
    this.dot.title = label;
    this.wrap.appendChild(this.dot);

    this.syncTicker(expanded);
    if (expanded !== this.expanded) {
      this.expanded = expanded;
      // Metering only runs while a panel is actually on screen.
      this.onIntent({ kind: "panelState", open: expanded });
    }
  }

  /**
   * The widget can be parked anywhere, so the card has to pick its side at open time: it drops
   * below the dot in the top half of the viewport, rises above it in the bottom half, and aligns
   * its far edge with the dot so the card grows toward the middle of the screen.
   */
  private cardPlacement(): string {
    const r = this.dot.getBoundingClientRect();
    const vertical = r.top + r.height / 2 < window.innerHeight / 2 ? "card-below" : "card-above";
    const horizontal = r.left + r.width / 2 < window.innerWidth / 2 ? "card-left" : "card-right";
    return `${vertical} ${horizontal}`;
  }

  /** One shared 1s tick drives every countdown, and only while something is on screen. */
  private syncTicker(expanded: boolean): void {
    const needed = expanded && this.tickers.length > 0;
    if (needed && !this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), 1000);
    } else if (!needed && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private tick(): void {
    const now = this.now();
    for (const t of this.tickers) {
      t.el.textContent = t.text(now);
    }
  }

  /** A span whose text is recomputed every second, without re-rendering (and stealing focus). */
  private countdown(text: (now: number) => string): HTMLElement {
    const el = document.createElement("span");
    el.setAttribute("data-role", "countdown");
    el.textContent = text(this.now());
    this.tickers.push({ el, text });
    return el;
  }

  private panel(state: DisplayState): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "card";
    panel.setAttribute("data-role", "panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Voice connection");
    if (state.error) {
      panel.setAttribute("data-fault", state.error);
    }

    const head = document.createElement("div");
    head.className = "panel-head";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "Voice connection";
    const overall = document.createElement("span");
    overall.className = "overall";
    overall.setAttribute("data-role", "panel-overall");
    const { cls, pulse } = dotFor(state);
    const health: Health = cls === "status-ok" ? "ok" : cls === "status-warn" ? "warn" : "err";
    overall.className = `overall state-${health}`;
    overall.append(indicator(health, pulse), document.createTextNode(labelFor(state)));
    head.append(title, overall);
    panel.appendChild(head);
    panel.appendChild(this.separator());
    panel.appendChild(this.identityRows(state));
    panel.appendChild(this.separator());
    panel.appendChild(this.footer(state));
    return panel;
  }

  private separator(): HTMLElement {
    const sep = document.createElement("div");
    sep.className = "sep";
    return sep;
  }

  private row(key: string, label: string, health: Health | null, value: Node, pulse = false): HTMLElement {
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("data-role", key);
    const labelEl = document.createElement("span");
    labelEl.className = "label";
    labelEl.textContent = label;
    const ind = health ? indicator(health, pulse) : document.createElement("span");
    if (!health) {
      ind.className = "ind";
    }
    const val = document.createElement("span");
    val.className = "val";
    val.appendChild(value);
    row.append(labelEl, ind, val);
    return row;
  }

  /** The headline: who this browser is, and what is likely to break a call right now. */
  private identityRows(state: DisplayState): HTMLElement {
    const rows = document.createElement("div");
    rows.className = "rows";
    rows.setAttribute("data-role", "identity-rows");
    const d = state.details;
    const fault = state.error;

    const extension = document.createElement("span");
    extension.textContent = d.account
      ? d.domain
        ? `${d.account} @ ${d.domain}`
        : d.account
      : "Not configured";
    if (!d.account) {
      extension.className = "muted";
    }
    rows.appendChild(this.row("row-extension", "Extension", null, extension));

    rows.appendChild(this.signalingRow(state));
    if (this.detailsOpen) {
      // The raw signals hang off the row they explain rather than a section of their own.
      rows.appendChild(this.detailRows(state));
    }

    // Microphone: the device name is the useful fact ("which mic is this?"), with a live meter
    // next to it so the answer to "is it picking anything up?" needs no separate test.
    if (fault === "MICROPHONE_BLOCKED") {
      rows.appendChild(this.faultRow("row-microphone", "Microphone", state));
    } else {
      const mic = document.createElement("span");
      mic.className = "mic-row";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = d.micDeviceLabel ?? "Default microphone";
      const meter = document.createElement("span");
      meter.className = "meter";
      meter.setAttribute("data-role", "mic-meter");
      meter.setAttribute("aria-hidden", "true");
      this.meterBars = METER_THRESHOLDS.map(() => {
        const bar = document.createElement("span");
        bar.className = "bar";
        meter.appendChild(bar);
        return bar;
      });
      mic.append(name, meter);
      const micHealth: Health = state.link.microphone === "ok" ? "ok" : state.link.microphone === "blocked" ? "err" : "idle";
      rows.appendChild(this.row("row-microphone", "Microphone", micHealth, mic));
      this.setMicLevel(d.micLevel ?? this.lastMicLevel);
    }

    if (fault === "MEDIA_FAILED") {
      rows.appendChild(this.faultRow("row-media", "Call audio", state));
    }

    // TURN is a standing deployment property, not a per-glance concern: one word here, with
    // the consequence spelled out in the details.
    const turn = document.createElement("span");
    turn.textContent = d.turnConfigured ? "Configured" : "Not configured";
    rows.appendChild(this.row("row-turn", "TURN", d.turnConfigured ? "ok" : "warn", turn));

    return rows;
  }

  private signalingRow(state: DisplayState): HTMLElement {
    const fault = state.error;
    if (fault === "REGISTRATION_FAILED" || fault === "CONNECTION_LOST") {
      return this.faultRow("row-signaling", "Signaling", state);
    }
    // SIP registration and WebSocket are one fact in SIP-over-WSS: a registration cannot be up
    // while its only transport is down, so two rows only ever staggered the same news.
    const value = document.createElement("span");
    value.className = "val-inline";
    const text = document.createElement("span");
    text.className = "text";
    value.append(text);
    const d = state.details;
    // The check mark already says "registered"; the countdown is the part worth the pixels.
    if (state.reconnecting) {
      text.append("WSS · reconnecting");
      if (d.reconnect) {
        text.append(" · ", this.retryCountdown(d.reconnect.nextAttemptAt, d.reconnect.attempt, "retrying"));
      }
      value.appendChild(this.chevron());
      return this.row("row-signaling", "Signaling", "warn", value, true);
    }
    if (state.link.registration === "up") {
      text.append("WSS");
      if (d.registrationExpiresAt !== null) {
        const expiresAt = d.registrationExpiresAt;
        text.append(" · ", this.countdown((now) => `expires in ${formatDuration(expiresAt - now)}`));
      }
      value.appendChild(this.chevron());
      return this.row("row-signaling", "Signaling", "ok", value);
    }
    const connecting = state.link.registration === "connecting" || state.link.websocket === "connecting";
    text.append(connecting ? "WSS · connecting…" : "WSS · not registered");
    value.appendChild(this.chevron());
    return this.row("row-signaling", "Signaling", connecting ? "warn" : "err", value, connecting);
  }

  private retryCountdown(nextAttemptAt: number, attempt: number, lead = "Retrying"): HTMLElement {
    return this.countdown((now) => {
      const remaining = nextAttemptAt - now;
      const when = remaining > 0 ? `${lead} in ${formatDuration(remaining)}` : `${lead} now`;
      return `${when} · attempt ${attempt}`;
    });
  }

  /**
   * The faulted signal, banded and imperative. The recovery step is not repeated here: the
   * footer carries exactly one emphasised action, so the row stays a statement of what broke.
   */
  private faultRow(key: string, label: string, state: DisplayState): HTMLElement {
    const code = state.error!;
    const copy = FAULT_COPY[code];
    const value = document.createElement("span");
    const message = document.createElement("div");
    message.className = "headline";
    message.setAttribute("data-role", "fault-message");
    message.textContent = copy.message(state.details.lastError?.reasonPhrase ?? "");
    value.appendChild(message);

    const retry = state.details.reconnect;
    if (retry) {
      const line = document.createElement("div");
      line.className = "retry";
      line.appendChild(this.retryCountdown(retry.nextAttemptAt, retry.attempt));
      value.appendChild(line);
    }

    const row = this.row(key, label, "err", value);
    row.classList.add("fault");
    row.setAttribute("aria-live", "polite");
    return row;
  }

  /**
   * The raw signals, collapsed by default behind the Signaling row's chevron: protocol truth
   * for a support ticket, never the headline. TURN's consequence is spelled out here, where
   * there is room for it.
   */
  private detailRows(state: DisplayState): HTMLElement {
    const rows = document.createElement("div");
    rows.className = "detail-rows";
    rows.setAttribute("data-role", "details");
    const entries: Array<{ key: string; label: string; text: string; health: Health }> = DETAIL_ROWS.map((row) => ({
      key: `detail-${row.label.toLowerCase().replace(/\s+/g, "-")}`,
      label: row.label,
      ...row.value(state.link)
    }));
    entries.push({
      key: "detail-turn",
      label: "TURN",
      text: state.details.turnConfigured ? "Configured" : "Not configured — calls may fail on restricted networks",
      health: state.details.turnConfigured ? "ok" : "warn"
    });
    for (const entry of entries) {
      const value = document.createElement("span");
      value.textContent = entry.text;
      rows.appendChild(this.row(entry.key, entry.label, entry.health, value));
    }
    return rows;
  }

  /** The chevron that opens the raw signals, on the row they explain. */
  private chevron(): HTMLElement {
    const b = document.createElement("button");
    b.className = "chev";
    b.setAttribute("data-role", "details-toggle");
    b.setAttribute("aria-expanded", String(this.detailsOpen));
    b.setAttribute("aria-label", this.detailsOpen ? "Hide connection details" : "Show connection details");
    b.textContent = this.detailsOpen ? "\u2304" : "\u203A";
    b.addEventListener("click", () => {
      this.detailsOpen = !this.detailsOpen;
      this.render();
    });
    return b;
  }

  private footer(state: DisplayState): HTMLElement {
    const foot = document.createElement("div");
    foot.className = "panel-foot";
    const link = (label: string, role: string, onClick: () => void): HTMLElement => {
      const b = document.createElement("button");
      b.className = "link";
      b.setAttribute("data-role", role);
      b.textContent = label;
      b.addEventListener("click", onClick);
      return b;
    };
    // Exactly one emphasised action at a time: the recovery step for the current fault, or
    // plain Reconnect when nothing is broken.
    const fault = state.error ? FAULT_COPY[state.error] : null;
    if (fault) {
      const primary = link(fault.action, "act-primary", () => this.onIntent(fault.intent));
      primary.classList.add("primary");
      foot.appendChild(primary);
      foot.appendChild(link("Settings", "act-settings", () => this.onIntent({ kind: "openOptions", section: "account" })));
    } else {
      foot.appendChild(link("Reconnect", "act-reconnect", () => this.onIntent({ kind: "retry" })));
    }
    foot.appendChild(
      link(this.micStatus ?? "Test microphone", "act-test-mic", () => {
        this.micStatus = "Testing…";
        this.micTestPending = true;
        this.render();
        this.onIntent({ kind: "testMic" });
      })
    );
    foot.appendChild(link(this.copyStatus ?? "Copy diagnostics", "act-copy", () => void this.copyDiagnostics(state)));
    if (!fault) {
      foot.appendChild(link("Settings", "act-settings", () => this.onIntent({ kind: "openOptions", section: "account" })));
    }
    const version = document.createElement("span");
    version.className = "version";
    version.setAttribute("data-role", "version");
    version.textContent = `v${this.env.version}`;
    foot.appendChild(version);
    return foot;
  }

  /** Result of the offscreen microphone test, shown next to the action that triggered it. */
  reportMicTest(ok: boolean): void {
    this.micStatus = ok ? "Microphone OK" : "Microphone blocked";
    this.render();
    if (!ok) {
      this.onIntent({ kind: "micBlocked" });
    }
    if (this.micStatusTimer) {
      clearTimeout(this.micStatusTimer);
    }
    this.micStatusTimer = setTimeout(() => {
      this.micStatusTimer = null;
      this.micStatus = null;
      this.render();
    }, 4000);
  }

  private async copyDiagnostics(state: DisplayState): Promise<void> {
    const text = buildDiagnostics(state, this.env.version, this.now());
    try {
      await this.writeClipboard(text);
      this.copyStatus = "Copied";
    } catch {
      this.copyStatus = "Copy failed";
    }
    this.render();
    setTimeout(() => {
      this.copyStatus = null;
      this.render();
    }, 2000);
  }
}
