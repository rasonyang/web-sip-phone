import { beforeEach, describe, expect, it } from "vitest";
import { clearDiag, getDiagEntries } from "../../src/offscreen/diag-log.js";
import { Ringtone } from "../../src/offscreen/ringtone.js";

/**
 * Stands in for the offscreen document's `<audio id="ringtone">`. `play()` is deferred so the
 * tests can drive the exact races the real element produces: a pause() landing while play() is
 * still pending, and a rejection arriving after a later start()/stop().
 */
function fakeAudio() {
  // One settler per play() call, so a test can settle an *earlier* attempt after a later
  // start() has already replaced it — exactly the ordering a superseded ring produces.
  const settlers: Array<{ resolve(): void; reject(e: unknown): void }> = [];
  const el = {
    loop: false,
    currentTime: 7, // a non-zero position, as a cancelled ring would leave behind
    paused: true,
    playCalls: 0,
    pauseCalls: 0,
    play(): Promise<void> {
      el.playCalls++;
      el.paused = false;
      return new Promise<void>((resolve, reject) => {
        settlers.push({ resolve, reject });
      });
    },
    pause(): void {
      el.pauseCalls++;
      el.paused = true;
    },
    /** Resolve a play() promise, as a browser does once playback starts. */
    started(nth = settlers.length - 1): Promise<void> {
      settlers[nth]?.resolve();
      return Promise.resolve();
    },
    /** Reject a play() promise with a DOMException-shaped error. */
    async failed(name: string, nth = settlers.length - 1): Promise<void> {
      settlers[nth]?.reject(Object.assign(new Error("play() failed"), { name }));
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return el;
}

beforeEach(() => clearDiag());

describe("Ringtone", () => {
  it("loops the element and plays from the top of the cadence", async () => {
    const el = fakeAudio();
    const ring = new Ringtone(el as unknown as HTMLAudioElement);
    expect(el.loop).toBe(true);

    ring.start();
    expect(el.playCalls).toBe(1);
    expect(el.currentTime).toBe(0);
    await el.started();
    expect(el.paused).toBe(false);
  });

  it("start() is idempotent while already ringing", async () => {
    const el = fakeAudio();
    const ring = new Ringtone(el as unknown as HTMLAudioElement);
    ring.start();
    await el.started();
    ring.start();
    ring.start();
    expect(el.playCalls).toBe(1);
  });

  it("stop() pauses and rewinds, and is idempotent", async () => {
    const el = fakeAudio();
    const ring = new Ringtone(el as unknown as HTMLAudioElement);
    ring.start();
    await el.started();
    el.currentTime = 3.2;

    ring.stop();
    expect(el.pauseCalls).toBe(1);
    expect(el.paused).toBe(true);
    expect(el.currentTime).toBe(0);

    ring.stop();
    ring.stop();
    expect(el.pauseCalls).toBe(1);
  });

  it("stop() during a pending play() silences it, and the AbortError is not logged", async () => {
    const el = fakeAudio();
    const ring = new Ringtone(el as unknown as HTMLAudioElement);
    ring.start();
    ring.stop(); // pause() interrupts the pending play()
    await el.failed("AbortError");

    expect(el.paused).toBe(true);
    expect(getDiagEntries()).toEqual([]);
  });

  it("swallows an autoplay refusal: it is logged, and the call is otherwise untouched", async () => {
    const el = fakeAudio();
    const ring = new Ringtone(el as unknown as HTMLAudioElement);
    ring.start();
    await el.failed("NotAllowedError");

    const entries = getDiagEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("ringtone playback refused");
    // A refused ring must not wedge the player: the next call still tries to ring.
    ring.start();
    expect(el.playCalls).toBe(2);
  });

  it("ignores a rejection from a play() that a later start() has superseded", async () => {
    const el = fakeAudio();
    const ring = new Ringtone(el as unknown as HTMLAudioElement);
    ring.start(); // call 1
    ring.stop();
    ring.start(); // call 2 — a new ring is now wanted
    await el.failed("NotAllowedError", 0); // call 1's promise finally rejects

    expect(getDiagEntries()).toEqual([]);
    // The stale rejection must not have left the player thinking it is silent: a stop()
    // still has to reach the element, or call 2 would ring forever.
    ring.stop();
    expect(el.pauseCalls).toBe(2);
    expect(el.paused).toBe(true);
  });

  it("survives an element that throws on seeking", () => {
    const el = fakeAudio();
    Object.defineProperty(el, "currentTime", {
      get: () => 0,
      set: () => {
        throw new Error("InvalidStateError");
      }
    });
    const ring = new Ringtone(el as unknown as HTMLAudioElement);
    expect(() => ring.start()).not.toThrow();
    expect(el.playCalls).toBe(1);
    expect(() => ring.stop()).not.toThrow();
    expect(el.pauseCalls).toBe(1);
  });
});
