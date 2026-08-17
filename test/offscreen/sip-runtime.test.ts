import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OffscreenStatus, RuntimeConfig } from "../../src/shared/messages.js";
import {
  parseExpiresSeconds,
  SipRuntime,
  type ResponseLike,
  type RegistererLike,
  type UaDelegate,
  type UaFactory,
  type UaLike
} from "../../src/offscreen/sip-runtime.js";

vi.mock("../../src/offscreen/media.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeMicPermission: () => Promise.resolve(micState),
  readMicLabel: () => Promise.resolve(micLabel)
}));

let micState: "granted" | "blocked" = "granted";
let micLabel: string | null = "Studio Mic";
/** Response handed to the register request delegate; drives expiry and reason-phrase parsing. */
let registerResponse: ResponseLike | undefined;

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
  register(opts?: { requestDelegate?: { onAccept?: (r?: ResponseLike) => void; onReject?: (r?: ResponseLike) => void } }) {
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
    if (rejectRegister) opts?.requestDelegate?.onReject?.(registerResponse);
    else opts?.requestDelegate?.onAccept?.(registerResponse);
    return Promise.resolve();
  }
  unregister() { this.unregisters++; return Promise.resolve(); }
}

let ua: FakeUa;
let registerer: FakeRegisterer;
let statuses: OffscreenStatus[];
/** Stand-in for the offscreen mic meter's current level. */
let micLevel_: number | null = null;

function makeRuntime() {
  statuses = [];
  const factory: UaFactory = {
    create: (_cfg, delegate) => {
      ua = new FakeUa(delegate);
      registerer = new FakeRegisterer();
      return { ua, registerer };
    }
  };
  return new SipRuntime({
    factory,
    audio: {} as HTMLAudioElement,
    onStatus: (s) => statuses.push(s),
    micLevel: () => micLevel_
  });
}

const last = () => statuses[statuses.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  micState = "granted";
  micLabel = "Studio Mic";
  micLevel_ = null;
  registerResponse = undefined;
  rejectRegister = false;
  manualRegister = false;
  // Zero jitter by default so the timing-sensitive tests stay deterministic; the jitter
  // tests override this per-case.
  vi.spyOn(Math, "random").mockReturnValue(0);
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

  it("a wedged reconnect times out, the UA is rebuilt, and the next attempt recovers", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    const firstUa = ua;
    firstUa.manualReconnect = true; // reconnect() hangs forever — post-sleep zombie transport
    firstUa.delegate.onDisconnect(new Error("system slept"));
    await vi.advanceTimersByTimeAsync(1100); // first attempt fires and wedges
    expect(firstUa.reconnects).toBe(1);
    expect(last().reconnecting).toBe(true);

    // 15s attempt timeout: counted as a failure, wedged UA replaced by a fresh one.
    await vi.advanceTimersByTimeAsync(15000 + 100);
    expect(ua).not.toBe(firstUa);
    expect(firstUa.stopped).toBe(1);
    expect(last().reconnecting).toBe(true);

    // Next backoff attempt runs start() on the fresh (never-started) UA and recovers.
    await vi.advanceTimersByTimeAsync(2000 + 100);
    expect(ua.started).toBe(1);
    expect(last().phase).toBe("ready");
    expect(last().reconnecting).toBe(false);
  });

  it("repeated wedges keep rebuilding and surface CONNECTION_LOST after 5 attempts", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    ua.delegate.onDisconnect(new Error("system slept"));
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = ua;
      current.manualReconnect = true;
      // start() on rebuilt UAs must wedge too for this scenario: network still down.
      current.start = () => new Promise<void>(() => {});
      await vi.advanceTimersByTimeAsync(Math.min(1000 * 2 ** attempt, 30000) + 100); // attempt fires
      await vi.advanceTimersByTimeAsync(15000 + 100); // and times out
      expect(ua).not.toBe(current);
    }
    expect(last().errors).toContain("CONNECTION_LOST");
    expect(last().reconnecting).toBe(true);
  });

  it("stop() during a wedged attempt does not resurrect state when the timeout fires", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    const firstUa = ua;
    firstUa.manualReconnect = true;
    firstUa.delegate.onDisconnect(new Error("system slept"));
    await vi.advanceTimersByTimeAsync(1100); // attempt wedges
    await rt.stop();
    const stopsAfterStop = ua.stopped;
    await vi.advanceTimersByTimeAsync(15000 + 100); // timeout fires after stop()
    expect(last().phase).toBe("stopped");
    expect(ua.stopped).toBe(stopsAfterStop); // no rebuild, no extra teardown
  });

  it("backoff delays carry random jitter (up to +30% of the base)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // worst case: full jitter
    const rt = makeRuntime();
    await rt.start(CONFIG);
    ua.reconnectFails = 99;
    ua.delegate.onDisconnect(new Error("down"));
    await vi.advanceTimersByTimeAsync(1000 + 100); // base delay elapsed…
    expect(ua.reconnects).toBe(0); // …but the jittered attempt has not fired yet
    await vi.advanceTimersByTimeAsync(300); // + 30% jitter boundary
    expect(ua.reconnects).toBe(1);
  });

  it("explicit zero-delay paths (retry) stay immediate — jitter never applies", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const rt = makeRuntime();
    await rt.start(CONFIG);
    ua.delegate.onDisconnect(new Error("down"));
    rt.retry();
    await vi.advanceTimersByTimeAsync(10);
    expect(ua.reconnects).toBe(1);
    expect(last().phase).toBe("ready");
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

describe("resync (post-sleep recovery)", () => {
  it("rebuilds and re-registers even while the runtime believes it is ready", async () => {
    // The reported field failure: after system sleep the server has expired the
    // registration but the zombie socket looks alive, so no disconnect ever fires.
    const rt = makeRuntime();
    await rt.start(CONFIG);
    expect(last().phase).toBe("ready");
    const zombieUa = ua;
    rt.resync();
    expect(last().reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(ua).not.toBe(zombieUa);
    expect(zombieUa.stopped).toBe(1);
    expect(ua.started).toBe(1); // fresh UA connects via start(), not reconnect()
    expect(last().phase).toBe("ready");
    expect(last().reconnecting).toBe(false);
    expect(registerer.registers).toBe(1); // fresh registerer, fresh REGISTER
  });

  it("recovers even when a reconnect attempt is wedged at resync time", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    const wedgedUa = ua;
    wedgedUa.manualReconnect = true;
    wedgedUa.delegate.onDisconnect(new Error("system slept"));
    await vi.advanceTimersByTimeAsync(1100); // attempt fires and wedges
    rt.resync();
    // The wedged attempt still holds the in-flight slot; the resync attempt is queued
    // and runs as soon as the wedge's 15s timeout clears it.
    await vi.advanceTimersByTimeAsync(15000 + 200);
    expect(ua).not.toBe(wedgedUa);
    expect(last().phase).toBe("ready");
    expect(last().reconnecting).toBe(false);
  });

  it("is a no-op when the runtime is stopped", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    await rt.stop();
    const stopsBefore = ua.stopped;
    rt.resync();
    await vi.advanceTimersByTimeAsync(100);
    expect(ua.stopped).toBe(stopsBefore);
    expect(last().phase).toBe("stopped");
  });
});

describe("registration failure is never terminal", () => {
  it("a rejected REGISTER is retried automatically and recovers when the cause clears", async () => {
    rejectRegister = true;
    const rt = makeRuntime();
    await rt.start(CONFIG);
    expect(last().errors).toContain("REGISTRATION_FAILED");
    rejectRegister = false;
    await vi.advanceTimersByTimeAsync(30000 + 100);
    expect(registerer.registers).toBe(2);
    expect(last().phase).toBe("ready");
    expect(last().errors).not.toContain("REGISTRATION_FAILED");
  });

  it("keeps retrying on a 30s cadence while rejections continue", async () => {
    rejectRegister = true;
    const rt = makeRuntime();
    await rt.start(CONFIG);
    await vi.advanceTimersByTimeAsync(2 * 30000 + 200);
    expect(registerer.registers).toBe(3);
    expect(last().errors).toContain("REGISTRATION_FAILED");
  });

  it("a pending register retry is invalidated by stop()", async () => {
    rejectRegister = true;
    const rt = makeRuntime();
    await rt.start(CONFIG);
    const before = registerer.registers;
    await rt.stop();
    await vi.advanceTimersByTimeAsync(60000 + 200);
    expect(registerer.registers).toBe(before);
  });

  it("the liveness watchdog also fires while stuck registering", async () => {
    rejectRegister = true;
    const rt = makeRuntime();
    await rt.start(CONFIG);
    const zombieUa = ua;
    zombieUa.delegate.onTransportMessage("OPTIONS sip:x@y.invalid SIP/2.0\r\n");
    await vi.advanceTimersByTimeAsync(30000);
    zombieUa.delegate.onTransportMessage("OPTIONS sip:x@y.invalid SIP/2.0\r\n");
    await vi.advanceTimersByTimeAsync(95000); // pings stop: socket presumed dead
    rt.checkLiveness();
    await vi.advanceTimersByTimeAsync(10);
    expect(ua).not.toBe(zombieUa);
  });
});

describe("service worker restart resync", () => {
  it("a redundant start() while running replays the current status instead of staying silent", async () => {
    // MV3 kills the SW after ~30s idle; on restart it re-sends runtime/start and needs the
    // status replayed, otherwise it renders "Connecting…" forever over a healthy runtime.
    const rt = makeRuntime();
    await rt.start(CONFIG);
    expect(last().phase).toBe("ready");
    const before = statuses.length;
    const firstUa = ua;
    await rt.start(CONFIG);
    expect(statuses.length).toBe(before + 1);
    expect(last().phase).toBe("ready");
    expect(ua).toBe(firstUa); // pure status replay — no second UA, no re-register
    expect(registerer.registers).toBe(1);
  });
});

describe("liveness watchdog (server OPTIONS pings)", () => {
  const OPTIONS_MSG = "OPTIONS sip:x@y.invalid;transport=ws SIP/2.0\r\n";

  it("resyncs after ping silence exceeds 3 observed cadences", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    const zombieUa = ua;
    zombieUa.delegate.onTransportMessage(OPTIONS_MSG);
    await vi.advanceTimersByTimeAsync(30000);
    zombieUa.delegate.onTransportMessage(OPTIONS_MSG); // cadence learned: 30s
    await vi.advanceTimersByTimeAsync(89000);
    rt.checkLiveness();
    expect(ua).toBe(zombieUa); // 89s < 90s floor — not yet
    await vi.advanceTimersByTimeAsync(2000);
    rt.checkLiveness();
    await vi.advanceTimersByTimeAsync(10);
    expect(ua).not.toBe(zombieUa); // silence past threshold → rebuilt
    expect(last().phase).toBe("ready"); // and recovered via fresh start()+register
  });

  it("never arms when the server sends no OPTIONS at all", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    const sameUa = ua;
    await vi.advanceTimersByTimeAsync(600000); // ten minutes of legal silence
    rt.checkLiveness();
    await vi.advanceTimersByTimeAsync(10);
    expect(ua).toBe(sameUa);
    expect(last().phase).toBe("ready");
  });

  it("stays quiet while a reconnect is already in progress", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    ua.delegate.onTransportMessage(OPTIONS_MSG);
    ua.reconnectFails = 99;
    ua.delegate.onDisconnect(new Error("down"));
    const reconnectingUa = ua;
    await vi.advanceTimersByTimeAsync(200000);
    rt.checkLiveness();
    await vi.advanceTimersByTimeAsync(10);
    expect(ua).toBe(reconnectingUa); // no watchdog resync on top of the reconnect loop
  });

  it("a non-OPTIONS inbound message counts as life once armed", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    const sameUa = ua;
    sameUa.delegate.onTransportMessage(OPTIONS_MSG);
    await vi.advanceTimersByTimeAsync(80000);
    sameUa.delegate.onTransportMessage("SIP/2.0 200 OK\r\n"); // e.g. a register refresh reply
    await vi.advanceTimersByTimeAsync(80000); // 160s since OPTIONS, 80s since any message
    rt.checkLiveness();
    await vi.advanceTimersByTimeAsync(10);
    expect(ua).toBe(sameUa);
  });

  it("rebuild during a call force-clears the session so busy state cannot stick", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    // Simulate an in-progress call via the sessions manager's public surface: an
    // auto-answer INVITE that got accepted.
    ua.delegate.onTransportMessage(OPTIONS_MSG);
    rt.resync();
    await vi.advanceTimersByTimeAsync(10);
    expect(last().callInProgress).toBe(false);
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

function response(headers: Record<string, string>, statusCode?: number, reasonPhrase?: string): ResponseLike {
  return {
    message: {
      statusCode,
      reasonPhrase,
      getHeader: (name: string) => headers[name.toLowerCase()]
    }
  };
}

describe("start() on an already-running runtime", () => {
  it("replays the status for an unchanged config (service-worker restart resync)", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    const before = registerer.registers;
    statuses.length = 0;
    await rt.start({ ...CONFIG });
    expect(statuses.length).toBe(1);
    expect(last().phase).toBe("ready");
    expect(registerer.registers).toBe(before); // no re-registration, no new UA
  });

  it("restarts itself when the config changed under it", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    const firstUa = ua;
    await rt.start({ ...CONFIG, password: "new-pw" });
    // A worker that restarted cannot know it must stop first, so the runtime does it itself.
    expect(firstUa.stopped).toBe(1);
    expect(ua).not.toBe(firstUa);
    expect(last().phase).toBe("ready");
  });

  it("defers a config change while a call is in progress", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    const firstUa = ua;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rt as unknown as { callInProgress: boolean }).callInProgress = true;
    await rt.start({ ...CONFIG, password: "new-pw" });
    expect(firstUa.stopped).toBe(0);
    expect(ua).toBe(firstUa);
  });
});

describe("parseExpiresSeconds", () => {
  it("prefers the Expires header, then the Contact parameter, then the RFC default", () => {
    expect(parseExpiresSeconds(response({ expires: "120" }))).toBe(120);
    expect(parseExpiresSeconds(response({ contact: "<sip:1001@host;transport=wss>;expires=90" }))).toBe(90);
    expect(parseExpiresSeconds(response({}))).toBe(600);
    expect(parseExpiresSeconds(undefined)).toBe(600);
  });
});

describe("status payload for the panel", () => {
  it("reports the expiry the server granted, and the microphone device", async () => {
    registerResponse = response({ expires: "120" });
    const rt = makeRuntime();
    await rt.start(CONFIG);
    expect(last().registrationExpiresAt).toBe(Date.now() + 120_000);
    expect(last().micDeviceLabel).toBe("Studio Mic");
    expect(last().reconnect).toBeNull();
    expect(last().lastError).toBeNull();
  });

  it("carries the server's reason phrase with a rejected registration", async () => {
    rejectRegister = true;
    registerResponse = response({}, 403, "Forbidden");
    const rt = makeRuntime();
    await rt.start(CONFIG);
    expect(last().lastError).toEqual({ code: "REGISTRATION_FAILED", reasonPhrase: "403 Forbidden" });
    expect(last().registrationExpiresAt).toBeNull();
    // The re-register countdown is already on the status that reported the failure.
    expect(last().reconnect?.nextAttemptAt).toBe(Date.now() + 30_000);
  });

  it("counts the reconnect ladder down for the panel", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    ua.reconnectFails = 99;
    ua.delegate.onDisconnect(new Error("wss dropped"));
    const t0 = Date.now();
    expect(last().reconnect).toEqual({ attempt: 1, nextAttemptAt: t0 + 1000 });
    expect(last().registrationExpiresAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1100);
    // The first attempt ran at t0+1s and failed; the ladder's next rung is 2s after that.
    expect(last().reconnect).toEqual({ attempt: 2, nextAttemptAt: t0 + 1000 + 2000 });
  });

  it("attaches the reason to a persistent connection failure", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    ua.reconnectFails = 99;
    ua.delegate.onDisconnect(new Error("wss dropped"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(last().errors).toContain("CONNECTION_LOST");
    expect(last().lastError).toEqual({ code: "CONNECTION_LOST", reasonPhrase: "down" });
  });

  it("reports the fault the UI will show, not the most recent one", async () => {
    micState = "blocked";
    const rt = makeRuntime();
    await rt.start(CONFIG);
    // MICROPHONE_BLOCKED outranks everything else (design §16.5), so it owns the reason slot.
    expect(last().lastError).toEqual({ code: "MICROPHONE_BLOCKED", reasonPhrase: "permission not granted" });
  });

  it("passes the meter's level through, and clears everything on stop", async () => {
    const rt = makeRuntime();
    await rt.start(CONFIG);
    micLevel_ = 0.42;
    ua.delegate.onDisconnect(new Error("wss dropped"));
    expect(last().micLevel).toBe(0.42);
    micLevel_ = null;
    await rt.stop();
    expect(last().registrationExpiresAt).toBeNull();
    expect(last().reconnect).toBeNull();
    expect(last().lastError).toBeNull();
    expect(last().micLevel).toBeNull();
  });
});
