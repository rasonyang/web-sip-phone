import type { DotPosition, StoredDotPosition } from "./config.js";
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
  wssUrl: string;
  username: string;
  password: string;
  iceServers: RTCIceServer[];
}

export interface TabState {
  state: DisplayState;
  guardUnload: boolean;
  pos: StoredDotPosition | null;
}

export type Msg =
  | { target: "offscreen"; type: "runtime/start"; config: RuntimeConfig }
  | { target: "offscreen"; type: "runtime/stop" }
  | { target: "offscreen"; type: "runtime/retry" }
  | { target: "offscreen"; type: "runtime/testMic" }
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
  | { target: "background"; type: "config/changed" }
  | { target: "content"; type: "mic/level"; level: number }
  | { target: "content"; type: "state/update"; state: DisplayState; guardUnload: boolean; pos: StoredDotPosition | null }
  | { target: "options"; type: "state/update"; state: DisplayState };

export function isMsg(value: unknown): value is Msg {
  return typeof value === "object" && value !== null && "target" in value && "type" in value;
}
