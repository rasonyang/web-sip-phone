import type { OffscreenStatus } from "../shared/messages.js";
import { type DisplayState, type ErrorCode, IDLE_LINK, RuntimeState, selectDisplayError } from "../shared/state.js";

const ERROR_TO_RUNTIME: Record<ErrorCode, RuntimeState> = {
  MICROPHONE_BLOCKED: RuntimeState.MicrophoneBlocked,
  MEDIA_FAILED: RuntimeState.MediaFailed,
  REGISTRATION_FAILED: RuntimeState.RegistrationFailed,
  CONNECTION_LOST: RuntimeState.ConnectionLost
};

export function computeDisplayState(input: {
  configured: boolean;
  allowTabCount: number;
  offscreen: OffscreenStatus | null;
}): DisplayState {
  const { configured, allowTabCount, offscreen } = input;
  const link = offscreen?.link ?? IDLE_LINK;
  const reconnecting = offscreen?.reconnecting ?? false;
  const busy = offscreen?.callInProgress ?? false;

  if (!configured) {
    return { runtime: RuntimeState.Unconfigured, error: null, reconnecting: false, busy: false, link };
  }
  if (allowTabCount === 0) {
    return { runtime: RuntimeState.InactiveNoAllowedSite, error: null, reconnecting: false, busy: false, link };
  }

  const error = selectDisplayError(offscreen?.errors ?? []);
  if (error) {
    return { runtime: ERROR_TO_RUNTIME[error], error, reconnecting, busy, link };
  }

  switch (offscreen?.phase) {
    case "registering":
      return { runtime: RuntimeState.Registering, error: null, reconnecting, busy, link };
    case "ready":
      return { runtime: RuntimeState.Ready, error: null, reconnecting, busy, link };
    default:
      // "connecting", "stopped", or offscreen not yet created — runtime is starting up.
      return { runtime: RuntimeState.Connecting, error: null, reconnecting, busy, link };
  }
}
