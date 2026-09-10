import { diag } from "./diag-log.js";

/** What the call session needs from a ringtone; both calls must be idempotent. */
export interface RingtonePlayer {
  start(): void;
  stop(): void;
}

/**
 * The inbound ringtone (design.md §9.4). One reusable `<audio loop>` element playing the
 * bundled asset — no Web Audio, no timers: the 6 s ring cadence lives inside the file, so
 * looping the element is the whole cadence.
 *
 * Playback is best-effort by design: a call must never fail, and the state machine must never
 * stall, because a sound could not be played.
 */
export class Ringtone implements RingtonePlayer {
  /** Whether the ringtone is currently wanted; a pending play() may not reflect it yet. */
  private ringing = false;
  /** Bumped by every start()/stop() so a late play() rejection from a superseded call is ignored. */
  private generation = 0;

  constructor(private audio: HTMLAudioElement) {
    audio.loop = true;
  }

  start(): void {
    if (this.ringing) {
      return;
    }
    this.ringing = true;
    const gen = ++this.generation;
    // Always ring from the top of the cadence: a previous call may have been cancelled four
    // seconds into the silent half, and the next one must not open on that silence.
    this.rewind();
    const played = this.audio.play() as Promise<void> | undefined;
    void played?.catch((e: unknown) => {
      // A stop() (or a newer start()) has since superseded this attempt. Chrome rejects a
      // pending play() with AbortError when pause() interrupts it, so this is the normal
      // path for a call cancelled within milliseconds — not something to report.
      if (gen !== this.generation) {
        return;
      }
      // An offscreen document is not gesture-gated, so a genuine autoplay refusal would be
      // surprising: log it, give up on this ring, and let the call continue silently.
      this.ringing = false;
      diag("call", "ringtone playback refused", { error: String(e) });
    });
  }

  stop(): void {
    this.generation++;
    if (!this.ringing) {
      return;
    }
    this.ringing = false;
    try {
      this.audio.pause();
    } catch (e) {
      diag("call", "ringtone stop failed", { error: String(e) });
    }
    this.rewind();
  }

  private rewind(): void {
    try {
      this.audio.currentTime = 0;
    } catch {
      // Not seekable yet (the asset is still loading), in which case it starts at 0 anyway.
    }
  }
}
