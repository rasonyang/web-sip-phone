import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OffscreenStatus, RuntimeConfig } from "../../src/shared/messages.js";
import {
  SipRuntime,
  type RegistererLike,
  type UaDelegate,
  type UaFactory,
  type UaLike
} from "../../src/offscreen/sip-runtime.js";

vi.mock("../../src/offscreen/media.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeMicPermission: () => Promise.resolve(micState)
}));

let micState: "granted" | "blocked" = "granted";

const CONFIG: RuntimeConfig = {
  sipUri: "sip:1001@voice.example.com",
  wssUrl: "wss://voice.example.com/",
  username: "1001",
  password: "pw",
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

class FakeUa implements UaLike {
  started = 0;
  stopped = 0;
  reconnects = 0;
  reconnectFails = 0;
  // Instrumentation for the concurrency regression tests below. Unused (and inert) by every
  // pre-existing test: manualReconnect defaults to false, so reconnect() behaves exactly as
  // before unless a test opts in.
  manualReconnect = false;
  concurrentReconnects = 0;
  maxConcurrentReconnects = 0;
  pendingReconnects: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  constructor(public delegate: UaDelegate) {}
  start() { this.started++; this.delegate.onConnect(); return Promise.resolve(); }
  stop() { this.stopped++; return Promise.resolve(); }
  reconnect() {
    this.reconnects++;
    this.concurrentReconnects++;
    this.maxConcurrentReconnects = Math.max(this.maxConcurrentReconnects, this.concurrentReconnects);
    if (this.manualReconnect) {
      return new Promise<void>((resolve, reject) => {
        this.pendingReconnects.push({
          resolve: () => {
            this.concurrentReconnects--;
            this.delegate.onConnect();
            resolve();
          },
          reject: (e) => {
            this.concurrentReconnects--;
            reject(e);
          }
        });
      });
    }
    if (this.reconnectFails > 0) {
      this.reconnectFails--;
      this.concurrentReconnects--;
      return Promise.reject(new Error("down"));
    }
    this.concurrentReconnects--;
    this.delegate.onConnect();
    return Promise.resolve();
  }
}

let rejectRegister = false;
// Opt-in instrumentation for the "late REGISTER callback after stop()" regression tests: when
// true, register() neither accepts nor rejects immediately — it stashes the requestDelegate so
// the test can fire it manually, later, on a controllable schedule. Inert for every other test.
let manualRegister = false;

class FakeRegisterer implements RegistererLike {
  registers = 0;
  unregisters = 0;
  pendingRegisters: Array<{ fireAccept: () => void; fireReject: () => void }> = [];
  register(opts?: { requestDelegate?: { onAccept?: () => void; onReject?: () => void } }) {
    this.registers++;
    if (manualRegister) {
      return new Promise<void>((resolve) => {
        this.pendingRegisters.push({
          fireAccept: () => {
            opts?.requestDelegate?.onAccept?.();
            resolve();
          },
          fireReject: () => {
            opts?.requestDelegate?.onReject?.();
            resolve();
          }
        });
      });
    }
    if (rejectRegister) opts?.requestDelegate?.onReject?.();
    else opts?.requestDelegate?.onAccept?.();
    return Promise.resolve();
  }
  unregister() { this.unregisters++; return Promise.resolve(); }
}

let ua: FakeUa;
let registerer: FakeRegisterer;
let statuses: OffscreenStatus[];

function makeRuntime() {
  statuses = [];
  const factory: UaFactory = {
    create: (_cfg, delegate) => {
      ua = new FakeUa(delegate);
      registerer = new FakeRegisterer();
      return { ua, registerer };
    }
  };
  return new SipRuntime({ factory, audio: {} as HTMLAudioElement, onStatus: (s) => statuses.push(s) });
}

const last = () => statuses[statuses.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  micState = "granted";
  rejectRegister = false;
  manualRegister = false;
});

describe("registration lifecycle", () => {
  it("REGISTER success → ready with link up", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    expect(last().phase).toBe("ready");
    expect(last().link.registration).toBe("up");
    expect(last().link.websocket).toBe("up");
    expect(registerer.registers).toBe(1);
  });

  it("REGISTER rejection → REGISTRATION_FAILED error", async () => {
    rejectRegister = true; // module-level flag read by FakeRegisterer at register() time
    const rt = makeRuntime();
    await rt.start(CONFIG);
    expect(last().errors).toContain("REGISTRATION_FAILED");
  });

  it("blocked microphone → no registration, MICROPHONE_BLOCKED", async () => {
    micState = "blocked";
    const rt = makeRuntime();
    await rt.start(CONFIG);
    expect(last().phase).toBe("stopped");
    expect(last().errors).toEqual(["MICROPHONE_BLOCKED"]);
    expect(statuses.every((s) => s.link.registration !== "up")).toBe(true);
  });
});

describe("reconnect", () => {
  it("disconnect → backoff reconnect → re-register, reconnecting flag toggles", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    ua.delegate.onDisconnect(new Error("wss dropped"));
    expect(last().reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(1100); // first attempt at 1s
    expect(ua.reconnects).toBe(1);
    expect(last().reconnecting).toBe(false);
    expect(last().phase).toBe("ready");
    expect(registerer.registers).toBe(2);
  });

  it("5 consecutive failures → CONNECTION_LOST, but retrying continues", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    ua.reconnectFails = 99;
    ua.delegate.onDisconnect(new Error("wss dropped"));
    // attempts at 1s,2s,4s,8s,16s → after 5th failure the error appears
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 16000 + 500);
    expect(ua.reconnects).toBeGreaterThanOrEqual(5);
    expect(last().errors).toContain("CONNECTION_LOST");
    await vi.advanceTimersByTimeAsync(30000 + 500); // capped interval, still trying
    expect(ua.reconnects).toBeGreaterThanOrEqual(6);
  });

  it("retry() resets backoff and reconnects immediately, success clears error", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    ua.reconnectFails = 99;
    ua.delegate.onDisconnect(new Error("x"));
    await vi.advanceTimersByTimeAsync(31000 + 500);
    ua.reconnectFails = 0;
    rt.retry();
    await vi.advanceTimersByTimeAsync(10);
    expect(last().errors).not.toContain("CONNECTION_LOST");
    expect(last().phase).toBe("ready");
  });
});

describe("stop", () => {
  it("unregisters then stops the UA and reports stopped", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    await rt.stop();
    expect(registerer.unregisters).toBe(1);
    expect(ua.stopped).toBe(1);
    expect(last().phase).toBe("stopped");
    expect(last().errors).toEqual([]);
  });

  it("stop cancels pending reconnects", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    ua.reconnectFails = 99;
    ua.delegate.onDisconnect(new Error("x"));
    await rt.stop();
    const attempts = ua.reconnects;
    await vi.advanceTimersByTimeAsync(120000);
    expect(ua.reconnects).toBe(attempts);
  });
});

// Regression tests for the 3 Important + 1 Minor concurrency defects found in code review:
// generation guard, single-flight reconnect, and the register()/stop() race.
describe("review fixes: concurrency and races", () => {
  it("[Important 1] reconnect success + register reject: never leaves a stale ready/up behind a failed re-register", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    ua.delegate.onDisconnect(new Error("wss dropped"));
    // The re-register triggered by the successful reconnect below is rejected; the initial
    // register() during start() above already succeeded, so this only affects the re-register.
    rejectRegister = true;
    await vi.advanceTimersByTimeAsync(1100); // first attempt at 1s; ua.reconnect() succeeds by default
    expect(ua.reconnects).toBe(1);
    expect(registerer.registers).toBe(2);
    expect(last().phase).not.toBe("ready");
    expect(last().link.registration).toBe("down");
    expect(last().errors).toContain("REGISTRATION_FAILED");
    expect(last().reconnecting).toBe(false);
  });

  it("[Important 2] stop() racing an in-flight reconnect: no register() after stop begins, single unregister, ends stopped", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    const registersAfterStart = registerer.registers;
    ua.manualReconnect = true;
    ua.delegate.onDisconnect(new Error("wss dropped"));
    await vi.advanceTimersByTimeAsync(1100); // first attempt fires; ua.reconnect() now pending
    expect(ua.pendingReconnects.length).toBe(1);

    await rt.stop(); // unregister (Expires 0) → ua.stop(), independent of the still-pending reconnect
    expect(registerer.unregisters).toBe(1);
    expect(ua.stopped).toBe(1);
    expect(last().phase).toBe("stopped");

    // Only now does the stale reconnect settle (successfully) — it must be a no-op.
    ua.pendingReconnects[0].resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(registerer.registers).toBe(registersAfterStart); // no re-register fired after stop began
    expect(last().phase).toBe("stopped"); // status not clobbered by the stale attempt
  });

  it("[Important 3] concurrent reconnect attempts are single-flight; a queued attempt still runs after the first settles", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    ua.manualReconnect = true;
    ua.delegate.onDisconnect(new Error("x"));
    await vi.advanceTimersByTimeAsync(1100); // first attempt fires; ua.reconnect() now pending
    expect(ua.pendingReconnects.length).toBe(1);

    rt.retry();
    await vi.advanceTimersByTimeAsync(5);
    rt.retry();
    await vi.advanceTimersByTimeAsync(5);

    // Both retry() calls landed while the first reconnect() was still in flight: neither should
    // have started a second concurrent reconnect() call.
    expect(ua.maxConcurrentReconnects).toBe(1);
    expect(ua.reconnects).toBe(1);

    ua.manualReconnect = false; // let the queued follow-up (once it starts) settle immediately
    ua.pendingReconnects[0].resolve();
    await vi.advanceTimersByTimeAsync(10);

    expect(ua.reconnects).toBeGreaterThanOrEqual(2); // the queued attempt actually ran afterward
    expect(ua.maxConcurrentReconnects).toBe(1); // still never more than one at a time
  });

  it("[Minor 4] start() overlapping a hanging stop() is not clobbered when the stale stop() finally completes", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    const firstRegisterer = registerer;
    const originalUnregister = firstRegisterer.unregister.bind(firstRegisterer);
    let releaseUnregister: () => void = () => {};
    firstRegisterer.unregister = (): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseUnregister = () => {
          void originalUnregister();
          resolve();
        };
      });

    const stopPromise = rt.stop(); // begins teardown; hangs at unregister()
    await rt.start(CONFIG); // fresh start supersedes the in-flight stop()

    expect(last().phase).toBe("ready");
    const secondRegisterer = registerer; // makeRuntime's factory reassigns this on each create()
    expect(secondRegisterer).not.toBe(firstRegisterer);
    expect(secondRegisterer.registers).toBe(1);

    releaseUnregister(); // let the stale stop() finish its teardown
    await stopPromise;
    expect(last().phase).toBe("ready"); // the stale stop() must not clobber the new runtime's status
  });

  it("[Important residual] a late REGISTER accept after stop() does not resurrect ready", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG); // reaches ready normally; registerer.registers === 1
    manualRegister = true;
    ua.delegate.onDisconnect(new Error("wss dropped"));
    await vi.advanceTimersByTimeAsync(1100); // first attempt: reconnect() succeeds, re-register() now pending
    expect(registerer.pendingRegisters.length).toBe(1);
    const pending = registerer.pendingRegisters[0];

    await rt.stop(); // stop() while the re-REGISTER is still in flight
    expect(last().phase).toBe("stopped");

    pending.fireAccept(); // late accept arrives after stop() already reported "stopped"
    await vi.advanceTimersByTimeAsync(10);
    expect(last().phase).toBe("stopped"); // must not resurrect "ready"
    expect(last().link.registration).not.toBe("up");
  });

  it("[Important residual] a late REGISTER reject after stop() adds no REGISTRATION_FAILED", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    manualRegister = true;
    ua.delegate.onDisconnect(new Error("wss dropped"));
    await vi.advanceTimersByTimeAsync(1100);
    expect(registerer.pendingRegisters.length).toBe(1);
    const pending = registerer.pendingRegisters[0];

    await rt.stop();
    expect(last().phase).toBe("stopped");
    expect(last().errors).toEqual([]);

    pending.fireReject(); // late reject arrives after stop()
    await vi.advanceTimersByTimeAsync(10);
    expect(last().phase).toBe("stopped");
    expect(last().errors).not.toContain("REGISTRATION_FAILED");
  });
});
