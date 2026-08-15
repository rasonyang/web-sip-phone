import type { DotPosition, StoredDotPosition } from "./config.js";
import type { DisplayState, ErrorCode, LinkStatus } from "./state.js";

export type Phase = "stopped" | "connecting" | "registering" | "ready";

export interface OffscreenStatus {
  phase: Phase;
  errors: ErrorCode[];
  reconnecting: boolean;
  link: LinkStatus;
  callInProgress: boolean;
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
  | { target: "background"; type: "offscreen/status"; status: OffscreenStatus }
  | { target: "background"; type: "ui/openOptions"; section?: "account" | "sites" | "advanced" }
  | { target: "background"; type: "ui/retry" }
  | { target: "background"; type: "ui/getState" }
  | { target: "background"; type: "ui/savePosition"; pos: DotPosition }
  | { target: "background"; type: "config/changed" }
  | { target: "content"; type: "state/update"; state: DisplayState; guardUnload: boolean; pos: StoredDotPosition | null }
  | { target: "options"; type: "state/update"; state: DisplayState };

export function isMsg(value: unknown): value is Msg {
  return typeof value === "object" && value !== null && "target" in value && "type" in value;
}
