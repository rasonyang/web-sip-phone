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

// Styling follows the shadcn/ui "neutral" palette (Inter, neutral-200 borders, neutral-600
// icon stroke) so the widget blends into shadcn-based host applications.
const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: "Inter Variable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.dot {
  position: relative; width: 38px; height: 38px; border-radius: 10px;
  border: 1px solid #e5e5e5; background: #fff; color: #525252;
  box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 1px 2px rgba(0,0,0,.06);
  cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0;
}
.dot:hover { background: #fafafa; }
.dot svg { width: 22px; height: 22px; display: block; pointer-events: none; }
.status {
  position: absolute; top: -4px; right: -4px; width: 12px; height: 12px;
  border-radius: 50%; border: 2px solid #fff; pointer-events: none;
}
.status-ok { background: #22c55e; }
.status-busy { background: #f59e0b; }
.status-off { background: #ef4444; }
.status-pulse { animation: wsp-pulse 1.2s ease-in-out infinite; }
@keyframes wsp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.card {
  background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 12px 14px;
  box-shadow: 0 4px 12px rgba(0,0,0,.08), 0 2px 4px rgba(0,0,0,.05);
  max-width: 240px; font-size: 12px; color: #171717;
}
.card h1 { font-size: 13px; margin: 0 0 4px; font-weight: 600; color: #171717; }
.card p { margin: 0 0 8px; color: #737373; }
.card button, .card a {
  font-size: 12px; font-weight: 500; border: 1px solid #e5e5e5; background: #fff; border-radius: 8px;
  padding: 5px 10px; cursor: pointer; color: #171717; text-decoration: none; display: inline-block;
}
.card button:hover, .card a:hover { background: #f5f5f5; }
.row { display: flex; justify-content: space-between; gap: 16px; padding: 2px 0; }
.row .val { color: #737373; }
.panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.panel-head strong { font-size: 13px; }
.panel-close { border: none; background: none; cursor: pointer; font-size: 14px; color: #737373; padding: 0 2px; }
.panel-close:hover { color: #171717; }
.panel-foot { margin-top: 8px; }
`;

// Hardware SIP desk phone, drawn in lucide conventions (24px grid, stroke 2, round caps).
const PHONE_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6Z"/>
  <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/>
  <path d="M9 12h.01M12 12h.01M15 12h.01M9 15.5h.01M12 15.5h.01M15 15.5h.01"/>
</svg>`;

type StatusView = { cls: "status-ok" | "status-busy" | "status-off"; pulse: boolean; label: string };

function statusFor(state: DisplayState): StatusView {
  if (state.error) {
    return { cls: "status-off", pulse: false, label: ERROR_COPY[state.error].title };
  }
  // Amber pulse = transitional (connecting/reconnecting); solid red is reserved for
  // hard failure states so a blink is never mistaken for "failed".
  if (state.reconnecting) {
    return { cls: "status-busy", pulse: true, label: "Reconnecting…" };
  }
  switch (state.runtime) {
    case RuntimeState.Ready:
      return state.busy
        ? { cls: "status-busy", pulse: false, label: "On a call" }
        : { cls: "status-ok", pulse: false, label: "Ready" };
    case RuntimeState.Connecting:
    case RuntimeState.Registering:
      return { cls: "status-busy", pulse: true, label: "Connecting…" };
    default:
      return { cls: "status-off", pulse: false, label: "Not connected" };
  }
}

const LINK_ROWS: Array<{ label: string; value: (l: LinkStatus) => string }> = [
  { label: "SIP Registration", value: (l) => l.registration },
  { label: "WebSocket", value: (l) => l.websocket },
  { label: "Microphone", value: (l) => l.microphone },
  { label: "Media", value: (l) => l.media }
];

export class WebSipPhoneView {
  readonly dot: HTMLElement;
  private shadow: ShadowRoot;
  private wrap: HTMLElement;
  private statusDot: HTMLElement;
  private state: DisplayState | null = null;
  private panelOpen = false;

  constructor(host: HTMLElement, private onIntent: (intent: UiIntent) => void) {
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
    this.dot.innerHTML = PHONE_ICON;
    this.statusDot = document.createElement("span");
    this.statusDot.className = "status status-off";
    this.statusDot.setAttribute("data-role", "status-dot");
    this.dot.appendChild(this.statusDot);
    this.dot.addEventListener("click", () => {
      if (this.state?.error) {
        return;
      }
      this.panelOpen = !this.panelOpen;
      this.render();
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
      this.wrap.appendChild(this.panel(state.link));
    }

    const { cls, pulse, label } = statusFor(state);
    this.statusDot.className = `status ${cls}${pulse ? " status-pulse" : ""}`;
    this.dot.setAttribute("aria-label", `Web SIP Phone status: ${label}`);
    this.dot.title = label;
    this.wrap.appendChild(this.dot);
  }

  private errorCard(code: ErrorCode): HTMLElement {
    const copy = ERROR_COPY[code];
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("data-role", "error-card");
    card.setAttribute("role", "alert");
    const h = document.createElement("h1");
    h.textContent = copy.title;
    const p = document.createElement("p");
    p.textContent = copy.detail;
    const btn = document.createElement("button");
    btn.setAttribute("data-role", "error-action");
    btn.textContent = copy.action;
    btn.addEventListener("click", () => this.onIntent(copy.intent));
    card.append(h, p, btn);
    return card;
  }

  private panel(link: LinkStatus): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "card";
    panel.setAttribute("data-role", "panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Voice connection");

    const head = document.createElement("div");
    head.className = "panel-head";
    const title = document.createElement("strong");
    title.textContent = "Voice connection";
    const close = document.createElement("button");
    close.className = "panel-close";
    close.setAttribute("data-role", "panel-close");
    close.setAttribute("aria-label", "Close");
    close.textContent = "✕";
    close.addEventListener("click", () => {
      this.panelOpen = false;
      this.render();
    });
    head.append(title, close);
    panel.appendChild(head);

    for (const row of LINK_ROWS) {
      const div = document.createElement("div");
      div.className = "row";
      const label = document.createElement("span");
      label.textContent = row.label;
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = row.value(link);
      div.append(label, val);
      panel.appendChild(div);
    }

    const foot = document.createElement("div");
    foot.className = "panel-foot";
    const settings = document.createElement("button");
    settings.textContent = "Settings";
    settings.addEventListener("click", () => this.onIntent({ kind: "openOptions", section: "account" }));
    foot.appendChild(settings);
    panel.appendChild(foot);
    return panel;
  }
}
