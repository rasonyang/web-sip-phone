import type { DotPosition, StoredDotPosition } from "./config.js";
import type { ProvisionRequest } from "./page-protocol.js";
import type { DisplayState, ErrorCode, FaultDetail, LinkStatus, ReconnectProgress } from "./state.js";

export type Phase = "stopped" | "connecting" | "registering" | "ready";

export interface OffscreenStatus {
  phase: Phase;
  errors: ErrorCode[];
  reconnecting: boolean;
  link: LinkStatus;
  callInProgress: boolean;
  /** Epoch ms the current registration expires at, as negotiated in the 200 OK. */
  registrationExpiresAt: number | null;
  /** Pending reconnect or re-register attempt, for the panel's countdown. */
  reconnect: ReconnectProgress | null;
  micDeviceLabel: string | null;
  /** 0..1 RMS; null unless a panel somewhere is expanded and metering is on. */
  micLevel: number | null;
  lastError: FaultDetail | null;
}

/** Result of the offscreen microphone test, relayed back to whoever asked for it. */
export interface MicTestResult {
  ok: boolean;
  label: string | null;
}

export interface RuntimeConfig {
  sipUri: string;
  serverUrl: string;
  username: string;
  /** Plaintext SIP password (manual source only). Mutually exclusive with a1Hash. */
  password?: string;
  /** md5(account:realm:password) supplied by a host page (provisioned source only). */
  a1Hash?: string;
  credentialSource: "manual" | "provisioned";
  iceServers: RTCIceServer[];
}

export interface TabState {
  state: DisplayState;
  pos: StoredDotPosition | null;
}

/**
 * The worker's answer to a `page/hello`. `declined` is a deliberate refusal (the sender is not a
 * top-frame Allow Site page) and the only reply that makes the content script stand down; a
 * missing reply means the worker never answered, which says nothing about the site.
 */
export type HelloReply = TabState | { declined: true };

export function isHelloDeclined(reply: unknown): reply is { declined: true } {
  return typeof reply === "object" && reply !== null && (reply as { declined?: unknown }).declined === true;
}

export type Msg =
  | { target: "offscreen"; type: "runtime/start"; config: RuntimeConfig }
  | { target: "offscreen"; type: "runtime/stop" }
  | { target: "offscreen"; type: "runtime/retry" }
  | { target: "offscreen"; type: "runtime/testMic" }
  // A permission read (never a capture) that backstops a missed PermissionStatus `change`.
  | { target: "offscreen"; type: "runtime/recheckMic" }
  // Mic metering is expensive (a live capture + AudioContext) and pointless when nobody is
  // looking, so it is gated on at least one expanded panel.
  | { target: "offscreen"; type: "runtime/micMeter"; on: boolean }
  | { target: "background"; type: "offscreen/status"; status: OffscreenStatus }
  // Level ticks arrive at 10 Hz: they carry their own message so they never drag the full
  // status pipeline (and its runtime re-evaluation) along at that rate.
  | { target: "background"; type: "offscreen/micLevel"; level: number }
  | { target: "background"; type: "ui/openOptions"; section?: "account" | "sites" | "advanced" }
  | { target: "background"; type: "ui/retry" }
  | { target: "background"; type: "ui/getState" }
  | { target: "background"; type: "ui/savePosition"; pos: DotPosition }
  | { target: "background"; type: "ui/testMic" }
  | { target: "background"; type: "ui/panelState"; open: boolean }
  // `signOut` is set only by Options' Sign Out / Clear Account: it also drops the held
  // provisioned credential, which no config diff can show (it is not in `config.account`).
  // `sites` is the Allow Sites change Options just made (see the handler for why the worker
  // cannot always work it out itself).
  | { target: "background"; type: "config/changed"; signOut?: boolean; sites?: { added: string[]; removed: string[] } }
  // Options "Re-sync": re-broadcast state to every Allow Site tab so host pages re-evaluate
  // whether to provision, and restart the provisioning grace window.
  | { target: "background"; type: "ui/resync" }
  // Page ↔ extension provisioning, relayed by the content script on behalf of a host page.
  | { target: "background"; type: "page/hello" }
  | { target: "background"; type: "page/provision"; credential: ProvisionRequest }
  | { target: "background"; type: "page/deprovision" }
  // A content script reporting that it is live, in answer to `site/recheck` (or on activation
  // of a prerendered page). The worker judges the message's `sender` — the one thing about it
  // Chrome never scrubs — and answers with `site/revoked` when that document's site is no longer
  // allowed; any other reply, or none, leaves the content script in place.
  | { target: "background"; type: "site/checkIn" }
  | { target: "content"; type: "mic/level"; level: number }
  // "Check in, please": sent to every open tab when an Allow Site or a host permission goes
  // away, because without the `tabs` permission the worker cannot see which tabs show the site.
  | { target: "content"; type: "site/recheck" }
  // This tab's site is no longer an Allow Site (or its host permission was revoked): the content
  // script removes its widget, the presence marker and the page bridge. The worker sends it as
  // its answer to a `site/checkIn`; one arriving as a pushed message is honoured the same way.
  | { target: "content"; type: "site/revoked" }
  | { target: "content"; type: "state/update"; state: DisplayState; pos: StoredDotPosition | null }
  | { target: "options"; type: "state/update"; state: DisplayState };

export function isMsg(value: unknown): value is Msg {
  return typeof value === "object" && value !== null && "target" in value && "type" in value;
}
