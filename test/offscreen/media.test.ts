import { afterEach, describe, expect, it, vi } from "vitest";
import { MIC_CONSTRAINTS, probeMicPermission, attachRemoteAudio, watchMicPermission } from "../../src/offscreen/media.js";

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

describe("watchMicPermission", () => {
  /** Minimal PermissionStatus stand-in: mutable state plus a change-listener registry. */
  function fakeStatus(state: string) {
    const listeners = new Set<() => void>();
    return {
      status: {
        state,
        addEventListener: (name: string, cb: () => void) => {
          if (name === "change") listeners.add(cb);
        },
        removeEventListener: (name: string, cb: () => void) => {
          if (name === "change") listeners.delete(cb);
        }
      },
      /** Flip the permission and deliver the `change` event, as Chrome would. */
      change(next: string) {
        this.status.state = next;
        [...listeners].forEach((cb) => cb());
      },
      listenerCount: () => listeners.size
    };
  }

  function stubStatus(state: string) {
    const fake = fakeStatus(state);
    vi.stubGlobal("navigator", { permissions: { query: () => Promise.resolve(fake.status) } });
    return fake;
  }

  /** Let the query promise and its .then continuation run. */
  const subscribed = () => Promise.resolve().then(() => {});

  it("does not fire for an initial state of granted", async () => {
    // The provisioned caller subscribes *because* a real capture just failed while permission
    // was already granted; firing here would retry it into an unbounded getUserMedia loop.
    const fake = stubStatus("granted");
    const onGranted = vi.fn();
    watchMicPermission(onGranted);
    await subscribed();
    expect(onGranted).not.toHaveBeenCalled();
    expect(fake.listenerCount()).toBe(1); // ...but it is listening for the transition
  });

  it("fires once on a change event that lands in granted", async () => {
    const fake = stubStatus("prompt");
    const onGranted = vi.fn();
    watchMicPermission(onGranted);
    await subscribed();
    fake.change("granted");
    expect(onGranted).toHaveBeenCalledTimes(1);
  });

  it("does not fire on a change event to denied", async () => {
    const fake = stubStatus("prompt");
    const onGranted = vi.fn();
    watchMicPermission(onGranted);
    await subscribed();
    fake.change("denied");
    expect(onGranted).not.toHaveBeenCalled();
  });

  it("unsubscribe detaches the listener: a later grant fires nothing", async () => {
    const fake = stubStatus("prompt");
    const onGranted = vi.fn();
    const unsubscribe = watchMicPermission(onGranted);
    await subscribed();
    unsubscribe();
    expect(fake.listenerCount()).toBe(0);
    fake.change("granted");
    expect(onGranted).not.toHaveBeenCalled();
  });

  it("unsubscribing before the query resolves never subscribes at all", async () => {
    const fake = fakeStatus("prompt");
    vi.stubGlobal("navigator", { permissions: { query: () => Promise.resolve(fake.status) } });
    const onGranted = vi.fn();
    watchMicPermission(onGranted)();
    await subscribed();
    expect(fake.listenerCount()).toBe(0);
    fake.change("granted");
    expect(onGranted).not.toHaveBeenCalled();
  });

  it("no Permissions API → a no-op unsubscribe, no throw", async () => {
    vi.stubGlobal("navigator", {});
    const onGranted = vi.fn();
    const unsubscribe = watchMicPermission(onGranted);
    expect(unsubscribe).toBeTypeOf("function");
    expect(() => unsubscribe()).not.toThrow();
    await subscribed();
    expect(onGranted).not.toHaveBeenCalled();
  });

  it("a rejected query degrades to no watcher instead of throwing", async () => {
    vi.stubGlobal("navigator", { permissions: { query: () => Promise.reject(new Error("unsupported")) } });
    const onGranted = vi.fn();
    expect(() => watchMicPermission(onGranted)()).not.toThrow();
    await subscribed();
    expect(onGranted).not.toHaveBeenCalled();
  });
});
