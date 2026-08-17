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
