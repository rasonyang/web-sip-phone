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

/**
 * Where the active SIP credential came from. PROVISIONED credentials are pushed in by an
 * allowed host page and never persist to the Options form.
 */
export type CredentialSource = "NONE" | "MANUAL" | "PROVISIONED";

/**
 * What the extension holds from a host page, independent of what it applies.
 * NONE: nothing held. ACTIVE: held and applied (credentialSource is PROVISIONED).
 * OVERRIDDEN: held but not applied because the user saved a manual account while provisioned
 * (credentialSource is MANUAL, and the held values are shown read-only in Options).
 */
export type ProvisionStatus = "NONE" | "ACTIVE" | "OVERRIDDEN";

/**
 * Why provisioning has not produced a usable credential. NOT_RECEIVED: an Allow Site page said
 * hello (or the user asked for a re-sync) and no valid provision arrived within the grace
 * window. INVALID: a provision arrived but was rejected by validation (missing or malformed
 * account/sipDomain/wssUrl/a1Hash/expiresAt). Cleared by the next accepted provision.
 */
export type ProvisionFault = null | "NOT_RECEIVED" | "INVALID";

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

/** Where the reconnect/re-register ladder currently stands, so the panel can count down to it. */
export interface ReconnectProgress {
  /** 1-based number of the attempt that is about to run. */
  attempt: number;
  nextAttemptAt: number;
}

/**
 * The active fault, with the server's own words. `reasonPhrase` is diagnostic detail
 * ("403 Forbidden", "device in use"): it turns "Registration failed" into copy the user can
 * act on, and it is the one place a SIP status code is allowed to surface (design §14.4).
 */
export interface FaultDetail {
  code: ErrorCode;
  reasonPhrase: string;
}

/**
 * Identity and risk context for the status panel. The panel answers "which extension am I,
 * on which server, and what is likely to break" — none of this is derivable from LinkStatus.
 * Never carries the SIP password.
 */
export interface StatusDetails {
  /** SIP account (extension) — the username only, never credentials. */
  account: string | null;
  domain: string | null;
  /** The SIP transport URL in use — tells ws:// apart from wss:// when debugging. */
  serverUrl: string | null;
  /** Epoch ms at which the current registration expires, for the countdown. */
  registrationExpiresAt: number | null;
  reconnect: ReconnectProgress | null;
  turnConfigured: boolean;
  micDeviceLabel: string | null;
  /** 0..1 RMS, sampled in the offscreen document; live only while a panel is expanded. */
  micLevel: number | null;
  lastError: FaultDetail | null;
  credentialSource: CredentialSource;
  /** Origin of the host page whose credential is held, null when provisionStatus is NONE. */
  provisionedBy: string | null;
  provisionStatus: ProvisionStatus;
  /** Account / realm of the held provisioned credential (read-only display), null when NONE. */
  provisionedAccount: string | null;
  provisionedDomain: string | null;
  /** Epoch ms the held credential was last accepted from the page ("last sync"). */
  provisionLastSyncAt: number | null;
  provisionFault: ProvisionFault;
  /** The user saved a manual account while provisioned; manual wins until cleared. */
  manualOverride: boolean;
}

export const EMPTY_DETAILS: StatusDetails = {
  account: null,
  domain: null,
  serverUrl: null,
  registrationExpiresAt: null,
  reconnect: null,
  turnConfigured: false,
  micDeviceLabel: null,
  micLevel: null,
  lastError: null,
  credentialSource: "NONE",
  provisionedBy: null,
  provisionStatus: "NONE",
  provisionedAccount: null,
  provisionedDomain: null,
  provisionLastSyncAt: null,
  provisionFault: null,
  manualOverride: false
};

export interface DisplayState {
  runtime: RuntimeState;
  error: ErrorCode | null;
  reconnecting: boolean;
  /**
   * A call is in progress. The one call-derived fact the UI receives: it tints the button and its
   * tooltip, and arms the unload guard. The status badge keeps reporting connection health.
   */
  busy: boolean;
  link: LinkStatus;
  details: StatusDetails;
}
