import type { OffscreenStatus } from "../shared/messages.js";
import {
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
  turnConfigured: boolean;
}

export function computeDisplayState(input: {
  configured: boolean;
  allowTabCount: number;
  offscreen: OffscreenStatus | null;
  identity?: Identity;
}): DisplayState {
  const { configured, allowTabCount, offscreen, identity } = input;
  const link = offscreen?.link ?? IDLE_LINK;
  const reconnecting = offscreen?.reconnecting ?? false;
  const busy = offscreen?.callInProgress ?? false;

  // Identity and TURN come from config (the worker knows them even before the runtime does);
  // everything else is live runtime truth relayed from the offscreen document.
  const details: StatusDetails = {
    account: identity?.account ?? null,
    domain: identity?.domain ?? null,
    turnConfigured: identity?.turnConfigured ?? false,
    registrationExpiresAt: offscreen?.registrationExpiresAt ?? null,
    reconnect: offscreen?.reconnect ?? null,
    micDeviceLabel: offscreen?.micDeviceLabel ?? null,
    micLevel: offscreen?.micLevel ?? null,
    lastError: offscreen?.lastError ?? null
  };

  if (!configured) {
    return { runtime: RuntimeState.Unconfigured, error: null, reconnecting: false, busy: false, link, details };
  }
  if (allowTabCount === 0) {
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
