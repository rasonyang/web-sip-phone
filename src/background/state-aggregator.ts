import type { OffscreenStatus } from "../shared/messages.js";
import {
  type CredentialSource,
  type ProvisionFault,
  type ProvisionStatus,
  type DisplayState,
  type ErrorCode,
  IDLE_LINK,
  RuntimeState,
  type StatusDetails,
  selectDisplayError
} from "../shared/state.js";

const ERROR_TO_RUNTIME: Record<ErrorCode, RuntimeState> = {
  MICROPHONE_BLOCKED: RuntimeState.MicrophoneBlocked,
  MEDIA_FAILED: RuntimeState.MediaFailed,
  REGISTRATION_FAILED: RuntimeState.RegistrationFailed,
  CONNECTION_LOST: RuntimeState.ConnectionLost
};

/** Who this browser is on the voice system, from config. The password is never part of it. */
export interface Identity {
  account: string | null;
  domain: string | null;
  serverUrl: string | null;
  turnConfigured: boolean;
  /** Where the active credential came from; absent means none is configured yet. */
  credentialSource?: CredentialSource;
  /** Origin of the host page that provisioned the credential, if any. */
  provisionedBy?: string | null;
  provisionStatus?: ProvisionStatus;
  provisionedAccount?: string | null;
  provisionedDomain?: string | null;
  provisionLastSyncAt?: number | null;
  provisionFault?: ProvisionFault;
  manualOverride?: boolean;
}

export function computeDisplayState(input: {
  configured: boolean;
  allowTabCount: number;
  offscreen: OffscreenStatus | null;
  /**
   * The last microphone value a runtime measured ("ok" | "blocked"), or null if none has yet.
   * Used only where the runtime reports nothing better: no runtime at all (torn down), or a
   * freshly started one whose gate has not run and so says "unknown". A live measurement wins.
   */
  lastMeasuredMic?: "ok" | "blocked" | null;
  identity?: Identity;
}): DisplayState {
  const { configured, allowTabCount, offscreen, identity, lastMeasuredMic } = input;
  const reported = offscreen?.link ?? IDLE_LINK;
  // "Unknown" from a host's point of view means "permission not settled" and triggers its
  // setup card, so it must not be what a teardown or a restart in between measurements says.
  const link =
    reported.microphone === "unknown" && lastMeasuredMic ? { ...reported, microphone: lastMeasuredMic } : reported;
  const reconnecting = offscreen?.reconnecting ?? false;
  const busy = offscreen?.callInProgress ?? false;

  // Identity and TURN come from config (the worker knows them even before the runtime does);
  // everything else is live runtime truth relayed from the offscreen document.
  const details: StatusDetails = {
    account: identity?.account ?? null,
    domain: identity?.domain ?? null,
    serverUrl: identity?.serverUrl ?? null,
    turnConfigured: identity?.turnConfigured ?? false,
    registrationExpiresAt: offscreen?.registrationExpiresAt ?? null,
    reconnect: offscreen?.reconnect ?? null,
    micDeviceLabel: offscreen?.micDeviceLabel ?? null,
    micLevel: offscreen?.micLevel ?? null,
    lastError: offscreen?.lastError ?? null,
    credentialSource: identity?.credentialSource ?? "NONE",
    provisionedBy: identity?.provisionedBy ?? null,
    provisionStatus: identity?.provisionStatus ?? "NONE",
    provisionedAccount: identity?.provisionedAccount ?? null,
    provisionedDomain: identity?.provisionedDomain ?? null,
    provisionLastSyncAt: identity?.provisionLastSyncAt ?? null,
    provisionFault: identity?.provisionFault ?? null,
    manualOverride: identity?.manualOverride ?? false
  };

  // Not while a call is in progress, for the same reason as the tab check below: `configured`
  // can go false mid-call (a provisioned-only credential can be revoked, e.g. its site removed
  // from Allow Sites, while the runtime keeps carrying the call), and "unconfigured, not busy"
  // would report that call as not happening.
  if (!configured && !busy) {
    return { runtime: RuntimeState.Unconfigured, error: null, reconnecting: false, busy: false, link, details };
  }
  // Not while a call is in progress: the runtime lifetime rule keeps it alive with no Allow Site
  // tab left (design.md §6.5), and reporting "inactive, not busy" for a call the extension is
  // genuinely carrying would be a lie to the Options page — the one surface still open then.
  if (allowTabCount === 0 && !busy) {
    return { runtime: RuntimeState.InactiveNoAllowedSite, error: null, reconnecting: false, busy: false, link, details };
  }

  const error = selectDisplayError(offscreen?.errors ?? []);
  if (error) {
    return { runtime: ERROR_TO_RUNTIME[error], error, reconnecting, busy, link, details };
  }

  switch (offscreen?.phase) {
    case "registering":
      return { runtime: RuntimeState.Registering, error: null, reconnecting, busy, link, details };
    case "ready":
      return { runtime: RuntimeState.Ready, error: null, reconnecting, busy, link, details };
    default:
      // "connecting", "stopped", or offscreen not yet created — runtime is starting up.
      return { runtime: RuntimeState.Connecting, error: null, reconnecting, busy, link, details };
  }
}
