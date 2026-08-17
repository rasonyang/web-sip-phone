import { MIC_CONSTRAINTS } from "./media.js";

/** 10 Hz: fast enough to read as a live meter, slow enough to stay off the message hot path. */
const SAMPLE_INTERVAL_MS = 100;
const FFT_SIZE = 1024;

export interface MicMeterDeps {
  /**
   * The call's own microphone track, when a call is up. Metering must never open a second
   * capture of a device that is already live — it reuses what the session already acquired.
   */
  getExistingTrack(): MediaStreamTrack | null;
  onLevel(level: number): void;
}

/**
 * Microphone level meter for the status panel. Lives in the offscreen document because the
 * content script must never touch the microphone: it computes an RMS level from an
 * AnalyserNode and pushes it out at a fixed rate, only while it is switched on.
 */
export class MicMeter {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  /** Only set when this meter opened the capture itself, and only then is it ours to stop. */
  private ownedStream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private lastLevel: number | null = null;
  private starting = false;

  constructor(private deps: MicMeterDeps) {}

  /** Last sampled level, or null while the meter is off. Read when composing a full status. */
  level(): number | null {
    return this.lastLevel;
  }

  setEnabled(on: boolean): void {
    if (on) {
      void this.start();
    } else {
      this.stop();
    }
  }

  private async start(): Promise<void> {
    if (this.ctx || this.starting) {
      return;
    }
    this.starting = true;
    try {
      const existing = this.deps.getExistingTrack();
      let stream: MediaStream;
      if (existing && existing.readyState === "live") {
        stream = new MediaStream([existing]);
      } else {
        // Permission is already granted whenever the runtime is up (design §6.1); an offscreen
        // document cannot prompt, so a rejection here simply means no meter.
        this.ownedStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        stream = this.ownedStream;
      }
      if (!this.starting) {
        return; // switched off while getUserMedia was pending
      }
      this.ctx = new AudioContext();
      // An offscreen document has no user gesture, so the context can start suspended and
      // then never advance its analyser. Resuming is permitted here (the document is created
      // with USER_MEDIA/AUDIO_PLAYBACK reasons) and is a no-op when it already runs.
      if (this.ctx.state === "suspended") {
        void this.ctx.resume().catch(() => {});
      }
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.buffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
      this.source = this.ctx.createMediaStreamSource(stream);
      this.source.connect(this.analyser);
      // Deliberately not connected to the destination: metering must never play the mic back.
      this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    } catch {
      this.teardown();
    } finally {
      this.starting = false;
    }
  }

  private sample(): void {
    if (!this.analyser || !this.buffer) {
      return;
    }
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (const v of this.buffer) {
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.buffer.length);
    this.lastLevel = Math.min(1, rms);
    this.deps.onLevel(this.lastLevel);
  }

  private stop(): void {
    this.starting = false;
    this.teardown();
  }

  private teardown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.analyser = null;
    this.buffer = null;
    this.ownedStream?.getTracks().forEach((t) => t.stop());
    this.ownedStream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.lastLevel = null;
  }
}
