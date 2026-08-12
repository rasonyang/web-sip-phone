import { afterEach, describe, expect, it, vi } from "vitest";
import { MIC_CONSTRAINTS, probeMicPermission, attachRemoteAudio } from "../../src/offscreen/media.js";

afterEach(() => vi.unstubAllGlobals());

function stubPermissions(state: string | Error) {
  vi.stubGlobal("navigator", {
    permissions: {
      query: () => (state instanceof Error ? Promise.reject(state) : Promise.resolve({ state }))
    }
  });
}

describe("MIC_CONSTRAINTS", () => {
  it("enables echo cancellation, noise suppression, auto gain", () => {
    expect(MIC_CONSTRAINTS).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  });
});

describe("probeMicPermission", () => {
  it("granted when permission state is granted", async () => {
    stubPermissions("granted");
    expect(await probeMicPermission()).toBe("granted");
  });
  it("blocked for denied, prompt, and query failure", async () => {
    stubPermissions("denied");
    expect(await probeMicPermission()).toBe("blocked");
    stubPermissions("prompt");
    expect(await probeMicPermission()).toBe("blocked");
    stubPermissions(new Error("unsupported"));
    expect(await probeMicPermission()).toBe("blocked");
  });
});

describe("attachRemoteAudio", () => {
  it("sets srcObject from receiver tracks and refreshes on track event", () => {
    const track = { kind: "audio" } as MediaStreamTrack;
    const listeners: Record<string, () => void> = {};
    const pc = {
      getReceivers: () => [{ track }],
      addEventListener: (name: string, cb: () => void) => (listeners[name] = cb)
    } as unknown as RTCPeerConnection;
    const streams: unknown[] = [];
    vi.stubGlobal("MediaStream", class { tracks: unknown[]; constructor(t: unknown[]) { this.tracks = t; streams.push(this); } });
    const audio = {} as HTMLAudioElement;
    attachRemoteAudio(pc, audio);
    expect(audio.srcObject).toBe(streams[0]);
    listeners["track"]();
    expect(audio.srcObject).toBe(streams[1]);
  });
});
