import { RuntimeState, type DisplayState, type ErrorCode, type LinkStatus } from "../shared/state.js";

export type UiIntent = { kind: "openOptions"; section: "account" | "sites" | "advanced" } | { kind: "retry" };

export const ERROR_COPY: Record<ErrorCode, { title: string; detail: string; action: string; intent: UiIntent }> = {
  MICROPHONE_BLOCKED: {
    title: "Microphone unavailable",
    detail: "Web SIP Phone needs microphone access",
    action: "Enable microphone",
    intent: { kind: "openOptions", section: "advanced" }
  },
  MEDIA_FAILED: {
    title: "Media connection failed",
    detail: "Calls cannot carry audio right now",
    action: "Configure TURN",
    intent: { kind: "openOptions", section: "advanced" }
  },
  REGISTRATION_FAILED: {
    title: "Registration failed",
    detail: "Check account settings",
    action: "Open Settings",
    intent: { kind: "openOptions", section: "account" }
  },
  CONNECTION_LOST: {
    title: "Voice connection lost",
    detail: "Unable to reach the voice server",
    action: "Retry",
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
.wrap {
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
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
  background: var(--card); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,.08), 0 2px 4px rgba(0,0,0,.04);
  width: 288px; color: var(--foreground); overflow: hidden;
}
.panel-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; }
.panel-head .title { font-size: 14px; font-weight: 500; white-space: nowrap; }
.panel-head .overall { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted-foreground); }
.sep { height: 1px; background: var(--border); }
.rows { display: flex; flex-direction: column; gap: 8px; padding: 16px; }
.row { display: flex; align-items: center; justify-content: space-between; font-size: 14px; }
.row .label { color: var(--muted-foreground); }
.row .val { display: flex; align-items: center; gap: 6px; }
.pip { width: 6px; height: 6px; border-radius: 9999px; flex: none; }
.pip-ok { background: var(--state-available); }
.pip-warn { background: var(--state-ringing); }
.pip-err { background: var(--state-breach); }
.pip-idle { background: var(--state-offline); }
.panel-foot { padding: 12px 16px; }
.err-card { padding: 14px 16px; }
.err-card h1 { font-size: 14px; font-weight: 600; margin: 0 0 4px; }
.err-card p { font-size: 13px; margin: 0 0 10px; color: var(--muted-foreground); }
button.action {
  font-size: 13px; font-weight: 500; border: 1px solid var(--border); background: var(--card);
  border-radius: 6px; padding: 6px 12px; cursor: pointer; color: var(--foreground);
}
button.action:hover { background: #f4f4f5; }
`;

// lucide "headset" (24px grid, stroke 2, round caps) — the host application uses the same
// icon for its voice terminal affordance.
const HEADSET_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5a9 9 0 0 1 18 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>
  <path d="M21 16v2a4 4 0 0 1-4 4h-5"/>
</svg>`;

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
    return ERROR_COPY[state.error].title;
  }
  if (state.reconnecting) {
    return state.busy ? "Reconnecting… — On a call" : "Reconnecting…";
  }
  switch (state.runtime) {
    case RuntimeState.Ready:
      return state.busy ? "On a call" : "Ready";
    case RuntimeState.Connecting:
    case RuntimeState.Registering:
      return "Connecting…";
    default:
      return "Not connected";
  }
}

type Pip = "pip-ok" | "pip-warn" | "pip-err" | "pip-idle";

// Raw link states are protocol words ("up", "ok"); the panel speaks the reader's language.
const LINK_ROWS: Array<{ label: string; value: (l: LinkStatus) => { text: string; pip: Pip } }> = [
  {
    label: "SIP registration",
    value: (l) =>
      l.registration === "up"
        ? { text: "Registered", pip: "pip-ok" }
        : l.registration === "connecting"
          ? { text: "Connecting", pip: "pip-warn" }
          : { text: "Not registered", pip: "pip-err" }
  },
  {
    label: "WebSocket",
    value: (l) =>
      l.websocket === "up"
        ? { text: "Connected", pip: "pip-ok" }
        : l.websocket === "connecting"
          ? { text: "Connecting", pip: "pip-warn" }
          : { text: "Disconnected", pip: "pip-err" }
  },
  {
    label: "Microphone",
    value: (l) =>
      l.microphone === "ok"
        ? { text: "Ready", pip: "pip-ok" }
        : l.microphone === "blocked"
          ? { text: "Blocked", pip: "pip-err" }
          : { text: "Unknown", pip: "pip-idle" }
  },
  {
    label: "Media",
    value: (l) =>
      l.media === "ok"
        ? { text: "Active", pip: "pip-ok" }
        : l.media === "failed"
          ? { text: "Failed", pip: "pip-err" }
          : { text: "Idle", pip: "pip-ok" }
  }
];

function pip(cls: Pip): HTMLElement {
  const el = document.createElement("span");
  el.className = `pip ${cls}`;
  return el;
}

export class WebSipPhoneView {
  readonly dot: HTMLElement;
  private shadow: ShadowRoot;
  private wrap: HTMLElement;
  private statusDot: HTMLElement;
  private state: DisplayState | null = null;
  private panelOpen = false;

  constructor(
    private host: HTMLElement,
    private onIntent: (intent: UiIntent) => void
  ) {
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
        return;
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
      this.panelOpen = false;
    }
    this.render();
  }

  private render(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    this.wrap.replaceChildren();

    if (state.error) {
      this.wrap.appendChild(this.errorCard(state.error));
    } else if (this.panelOpen) {
      this.wrap.appendChild(this.panel(state));
    }

    const { cls, pulse } = dotFor(state);
    const label = labelFor(state);
    this.statusDot.className = `status ${cls}${pulse ? " status-pulse" : ""}`;
    this.dot.className = `dot${state.busy ? " in-call" : ""}`;
    this.dot.setAttribute("aria-label", `Web SIP Phone status: ${label}`);
    this.dot.title = label;
    this.wrap.appendChild(this.dot);
  }

  private errorCard(code: ErrorCode): HTMLElement {
    const copy = ERROR_COPY[code];
    const card = document.createElement("div");
    card.className = "card err-card";
    card.setAttribute("data-role", "error-card");
    card.setAttribute("role", "alert");
    const h = document.createElement("h1");
    h.textContent = copy.title;
    const p = document.createElement("p");
    p.textContent = copy.detail;
    const btn = document.createElement("button");
    btn.className = "action";
    btn.setAttribute("data-role", "error-action");
    btn.textContent = copy.action;
    btn.addEventListener("click", () => this.onIntent(copy.intent));
    card.append(h, p, btn);
    return card;
  }

  private panel(state: DisplayState): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "card";
    panel.setAttribute("data-role", "panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Voice connection");

    const head = document.createElement("div");
    head.className = "panel-head";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "Voice connection";
    const overall = document.createElement("span");
    overall.className = "overall";
    overall.setAttribute("data-role", "panel-overall");
    const { cls } = dotFor(state);
    overall.append(pip(cls.replace("status-", "pip-") as Pip), document.createTextNode(labelFor(state)));
    head.append(title, overall);
    panel.appendChild(head);

    const sep = document.createElement("div");
    sep.className = "sep";
    panel.appendChild(sep);

    const rows = document.createElement("div");
    rows.className = "rows";
    for (const row of LINK_ROWS) {
      const div = document.createElement("div");
      div.className = "row";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = row.label;
      const val = document.createElement("span");
      val.className = "val";
      const { text, pip: pipCls } = row.value(state.link);
      val.append(pip(pipCls), document.createTextNode(text));
      div.append(label, val);
      rows.appendChild(div);
    }
    panel.appendChild(rows);

    const sep2 = document.createElement("div");
    sep2.className = "sep";
    panel.appendChild(sep2);

    const foot = document.createElement("div");
    foot.className = "panel-foot";
    const settings = document.createElement("button");
    settings.className = "action";
    settings.textContent = "Settings";
    settings.addEventListener("click", () => this.onIntent({ kind: "openOptions", section: "account" }));
    foot.appendChild(settings);
    panel.appendChild(foot);
    return panel;
  }
}
