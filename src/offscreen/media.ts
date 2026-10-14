export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
};

/**
 * The offscreen document cannot show a permission prompt; the grant is obtained once via the
 * options page. Anything other than an explicit "granted" therefore means blocked.
 */
export async function probeMicPermission(): Promise<"granted" | "blocked"> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state === "granted" ? "granted" : "blocked";
  } catch {
    return "blocked";
  }
}

/**
 * Open a real capture once and close it again, to prove the microphone is actually usable.
 *
 * A Permissions API "granted" only says the origin is allowed to ask; it says nothing about a
 * device that is missing, in use by another application, or disabled at the OS level. The
 * provisioned source uses this instead of the probe because a host page has no Options page to
 * fall back to when a registration silently fails to produce audio.
 */
export async function acquireMicOnce(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the microphone permission without probing a device, or null when it cannot be read.
 *
 * Unlike probeMicPermission this never turns a failed read into "blocked": the callers are
 * rechecks of a state they already hold, and acting on a read that failed (in either
 * direction) would flip a working runtime on no evidence.
 */
export async function queryMicPermission(): Promise<"granted" | "blocked" | null> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state === "granted" ? "granted" : "blocked";
  } catch {
    return null;
  }
}

/**
 * Call `onChange` with the new state (anything other than "granted" is "blocked") whenever
 * microphone permission *transitions*. Returns an unsubscribe.
 *
 * The offscreen document cannot prompt, so a blocked start has to wait for the grant to arrive
 * from somewhere else (the Options page, or Chrome's own site settings), and a running
 * registration has to notice the grant being taken away. Every failure mode — no Permissions
 * API, an unsupported descriptor, a rejected query — degrades to "no watcher", never to a
 * throw: this is a recovery path, and it must not be able to break the caller.
 *
 * Only a `change` event fires `onChange`; the initial state read never does. A provisioned
 * start gates on a real capture, and a capture can fail with the permission already "granted"
 * (no device attached, device in use, disabled at the OS level). Firing on the initial read
 * would hand the caller an immediate retry that fails identically, which re-subscribes, which
 * fires again — an unbounded getUserMedia loop.
 *
 * The cost is a narrow race: a change that lands before the subscription resolves is not
 * seen. That is accepted — the worker's recheck (page hello, Retry, visibility nudge), the
 * real-gate retry and "Test microphone" all re-evaluate, so the stall is recoverable.
 */
export function watchMicPermission(onChange: (state: "granted" | "blocked") => void): () => void {
  let status: PermissionStatus | null = null;
  let cancelled = false;
  const handler = (): void => {
    if (!cancelled && status) {
      onChange(status.state === "granted" ? "granted" : "blocked");
    }
  };
  try {
    void navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((s) => {
        if (cancelled) {
          return;
        }
        status = s;
        s.addEventListener("change", handler);
      })
      .catch(() => {});
  } catch {
    // navigator.permissions missing entirely, or query() throwing synchronously.
  }
  return () => {
    cancelled = true;
    status?.removeEventListener("change", handler);
  };
}

/**
 * Label of the microphone the runtime would use. Device labels are only exposed once mic
 * permission has been granted, so this returns null when blocked — which is exactly when the
 * panel has something more useful to say than a device name.
 */
export async function readMicLabel(): Promise<string | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const input = devices.find((d) => d.kind === "audioinput" && d.label);
    return input?.label ?? null;
  } catch {
    return null;
  }
}

export function attachRemoteAudio(pc: RTCPeerConnection, audio: HTMLAudioElement): void {
  const refresh = (): void => {
    const tracks = pc
      .getReceivers()
      .map((r) => r.track)
      .filter((t): t is MediaStreamTrack => t !== null);
    audio.srcObject = new MediaStream(tracks);
  };
  pc.addEventListener("track", refresh);
  refresh();
}
