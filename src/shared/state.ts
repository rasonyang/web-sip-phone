export enum RuntimeState {
  Unconfigured = "UNCONFIGURED",
  InactiveNoAllowedSite = "INACTIVE_NO_ALLOWED_SITE",
  Connecting = "CONNECTING",
  Registering = "REGISTERING",
  Ready = "READY",
  RegistrationFailed = "REGISTRATION_FAILED",
  ConnectionLost = "CONNECTION_LOST",
  MicrophoneBlocked = "MICROPHONE_BLOCKED",
  MediaFailed = "MEDIA_FAILED"
}

/** Internal only: drives SIP execution and unload guarding, never Web SIP Phone UI rendering. */
export enum CallState {
  Idle = "IDLE",
  Dialing = "DIALING",
  Ringing = "RINGING",
  Active = "ACTIVE",
  Held = "HELD",
  Failed = "FAILED",
  Ended = "ENDED"
}

export type ErrorCode = "MICROPHONE_BLOCKED" | "MEDIA_FAILED" | "REGISTRATION_FAILED" | "CONNECTION_LOST";

const ERROR_PRIORITY: ErrorCode[] = ["MICROPHONE_BLOCKED", "MEDIA_FAILED", "REGISTRATION_FAILED", "CONNECTION_LOST"];

export function selectDisplayError(errors: ErrorCode[]): ErrorCode | null {
  for (const code of ERROR_PRIORITY) {
    if (errors.includes(code)) {
      return code;
    }
  }
  return null;
}

export interface LinkStatus {
  registration: "up" | "connecting" | "down";
  websocket: "up" | "connecting" | "down";
  microphone: "ok" | "blocked" | "unknown";
  media: "ok" | "failed" | "idle";
}

export const IDLE_LINK: LinkStatus = {
  registration: "down",
  websocket: "down",
  microphone: "unknown",
  media: "idle"
};

export interface DisplayState {
  runtime: RuntimeState;
  error: ErrorCode | null;
  reconnecting: boolean;
  /** A call is in progress — the status dot shows busy (amber) instead of ready (green). */
  busy: boolean;
  link: LinkStatus;
}
