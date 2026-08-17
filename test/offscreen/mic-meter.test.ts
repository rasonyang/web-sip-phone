import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicMeter } from "../../src/offscreen/mic-meter.js";

// Minimal Web Audio doubles: the meter only needs an analyser that fills a buffer and a source
// it can connect. Every sample writes the same constant so the RMS is predictable.
let sampleValue = 0;
let closed = 0;
let createdSources = 0;
let gumCalls = 0;
let gumTracks: FakeTrack[] = [];

class FakeTrack {
  kind = "audio";
  readyState: "live" | "ended" = "live";
  stopped = 0;
  stop() {
    this.stopped++;
    this.readyState = "ended";
  }
}

class FakeAnalyser {
  fftSize = 0;
  connect() {}
  getFloatTimeDomainData(buffer: Float32Array) {
    buffer.fill(sampleValue);
  }
}

class FakeAudioContext {
  state = "suspended";
  resumed = 0;
  resume() {
    this.resumed++;
    this.state = "running";
    return Promise.resolve();
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  createMediaStreamSource() {
    createdSources++;
    return { connect: () => {}, disconnect: () => {} };
  }
  close() {
    closed++;
    return Promise.resolve();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  sampleValue = 0;
  closed = 0;
  createdSources = 0;
  gumCalls = 0;
  gumTracks = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaStream", class {
    constructor(public tracks: FakeTrack[] = []) {}
    getTracks() {
      return this.tracks;
    }
  });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () => {
        gumCalls++;
        const track = new FakeTrack();
        gumTracks.push(track);
        return Promise.resolve({ getTracks: () => [track] });
      }
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function meterWith(existing: FakeTrack | null) {
  const levels: number[] = [];
  const meter = new MicMeter({
    getExistingTrack: () => existing as unknown as MediaStreamTrack | null,
    onLevel: (l) => levels.push(l)
  });
  return { meter, levels };
}

describe("MicMeter", () => {
  it("samples at 10 Hz only while enabled", async () => {
    const { meter, levels } = meterWith(null);
    expect(levels).toEqual([]);
    meter.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0); // let getUserMedia resolve
    sampleValue = 0.5;
    await vi.advanceTimersByTimeAsync(1000);
    expect(levels.length).toBe(10);
    expect(levels.every((l) => Math.abs(l - 0.5) < 1e-6)).toBe(true);
    expect(meter.level()).toBeCloseTo(0.5);

    meter.setEnabled(false);
    const after = levels.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(levels.length).toBe(after);
    expect(meter.level()).toBeNull();
  });

  it("reuses the call's own microphone track instead of opening a second capture", async () => {
    const existing = new FakeTrack();
    const { meter } = meterWith(existing);
    meter.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(gumCalls).toBe(0);
    expect(createdSources).toBe(1);
    meter.setEnabled(false);
    // A borrowed track belongs to the call: stopping it would mute the call.
    expect(existing.stopped).toBe(0);
  });

  it("releases the capture it opened itself", async () => {
    const { meter } = meterWith(null);
    meter.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(gumCalls).toBe(1);
    meter.setEnabled(false);
    expect(gumTracks[0].stopped).toBe(1);
    expect(closed).toBe(1);
  });

  it("stays off when the microphone cannot be opened", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: () => Promise.reject(new Error("blocked")) }
    });
    const { meter, levels } = meterWith(null);
    meter.setEnabled(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(levels).toEqual([]);
    expect(meter.level()).toBeNull();
  });

  it("enabling twice does not start two meters", async () => {
    const { meter, levels } = meterWith(null);
    meter.setEnabled(true);
    meter.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    meter.setEnabled(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(gumCalls).toBe(1);
    expect(levels.length).toBe(10);
  });
});
