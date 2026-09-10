import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallState } from "../../src/shared/state.js";
import { CallSessionManager, type InvitationLike } from "../../src/offscreen/call-session.js";

// The fork's parser is exercised in its own repo; here we mock the sip.js surface so
// unit tests run without WebRTC. Integration tests (Task 20) use the real library.
// vi.mock's factory below is hoisted above this file's top-level code, so the mocks it
// references must be created via vi.hoisted() to avoid a temporal-dead-zone ReferenceError.
const { applyTalkAction, applyHoldAction } = vi.hoisted(() => ({
  applyTalkAction: vi.fn(() => Promise.resolve()),
  applyHoldAction: vi.fn(() => Promise.resolve())
}));
let autoAnswerDelay: number | undefined;
vi.mock("sip.js/lib/api/broadsoft/index.js", () => ({
  getAutoAnswerDelay: () => autoAnswerDelay,
  parseEventHeaderFromNotification: (n: { request: { getHeader(h: string): string | undefined } }) => {
    const ev = n.request.getHeader("event")?.split(";")[0].trim().toLowerCase();
    return ev === "talk" || ev === "hold" ? ev : undefined;
  },
  applyTalkAction,
  applyHoldAction,
  BroadSoftEvent: { Talk: "talk", Hold: "hold" },
  TalkAction: { Talk: "talk", Mute: "mute" }
}));

function makeInvitation(): InvitationLike & {
  fireState(s: string): void;
  fireNotify(event: string): Promise<void>;
  accepted: number;
  rejected: number[];
} {
  const stateListeners: Array<(s: string) => void> = [];
  const inv = {
    request: {},
    state: "Initial",
    delegate: undefined as InvitationLike["delegate"],
    stateChange: { addListener: (cb: (s: string) => void) => stateListeners.push(cb) },
    sessionDescriptionHandler: undefined,
    accepted: 0,
    rejected: [] as number[],
    accept: vi.fn(function (this: { accepted: number }) { inv.accepted++; return Promise.resolve(); }),
    reject: vi.fn((opts?: { statusCode: number }) => { inv.rejected.push(opts?.statusCode ?? 0); return Promise.resolve(); }),
    bye: vi.fn(() => Promise.resolve()),
    fireState(s: string) { inv.state = s; stateListeners.forEach((cb) => cb(s)); },
    async fireNotify(event: string) {
      const n = { request: { getHeader: (h: string) => (h.toLowerCase() === "event" ? event : undefined), body: "" }, accept: vi.fn(() => Promise.resolve()) };
      inv.delegate?.onNotify?.(n);
      // Fake timers are active: flush microtasks/timers instead of vi.waitFor.
      await vi.advanceTimersByTimeAsync(0);
      expect(n.accept).toHaveBeenCalled();
    }
  };
  return inv;
}

let states: CallState[];
let mediaFailed: number;
/** Ringtone start/stop in call order (design.md §9.4). */
let ringtone: Array<"start" | "stop">;

function makeManager() {
  states = [];
  mediaFailed = 0;
  ringtone = [];
  return new CallSessionManager({
    audio: {} as HTMLAudioElement,
    ringtone: { start: () => void ringtone.push("start"), stop: () => void ringtone.push("stop") },
    onChange: (s) => states.push(s),
    onMediaFailed: () => mediaFailed++
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  applyTalkAction.mockClear();
  applyHoldAction.mockClear();
  autoAnswerDelay = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("invite classification", () => {
  it("answer-after=0 → DIALING and auto-answer", async () => {
    autoAnswerDelay = 0;
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    expect(mgr.callState()).toBe(CallState.Dialing);
    await vi.advanceTimersByTimeAsync(10);
    expect(inv.accepted).toBe(1);
  });

  it("answer-after=2 → auto-answer after 2 s", async () => {
    autoAnswerDelay = 2;
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await vi.advanceTimersByTimeAsync(1900);
    expect(inv.accepted).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(inv.accepted).toBe(1);
  });

  it("negative answer-after → normal inbound (RINGING, no auto-answer)", async () => {
    autoAnswerDelay = -1;
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    expect(mgr.callState()).toBe(CallState.Ringing);
    await vi.advanceTimersByTimeAsync(5000);
    expect(inv.accepted).toBe(0);
  });

  it("no answer-after → RINGING, no auto-answer", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    expect(mgr.callState()).toBe(CallState.Ringing);
    await vi.advanceTimersByTimeAsync(60000);
    expect(inv.accepted).toBe(0);
  });
});

describe("second INVITE defense", () => {
  it("rejects a second INVITE with 486 and keeps the current session", async () => {
    const mgr = makeManager();
    const first = makeInvitation();
    mgr.handleInvite(first);
    const second = makeInvitation();
    mgr.handleInvite(second);
    expect(second.rejected).toEqual([486]);
    expect(mgr.callState()).toBe(CallState.Ringing);
  });
});

describe("NOTIFY handling", () => {
  it("talk while RINGING answers and goes ACTIVE", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await inv.fireNotify("talk");
    expect(mgr.callState()).toBe(CallState.Active);
    expect(inv.accepted).toBe(1); // RINGING+talk answers via invitation.accept
  });

  it("talk while DIALING goes ACTIVE without extra SIP action", async () => {
    autoAnswerDelay = 0;
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await vi.advanceTimersByTimeAsync(10);
    await inv.fireNotify("talk");
    expect(mgr.callState()).toBe(CallState.Active);
    expect(applyTalkAction).not.toHaveBeenCalled();
    expect(inv.accepted).toBe(1); // only the auto-answer
  });

  it("hold while ACTIVE goes HELD via applyHoldAction; talk resumes via applyTalkAction", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await inv.fireNotify("talk"); // ACTIVE
    await inv.fireNotify("hold");
    expect(mgr.callState()).toBe(CallState.Held);
    expect(applyHoldAction).toHaveBeenCalledTimes(1);
    await inv.fireNotify("talk");
    expect(mgr.callState()).toBe(CallState.Active);
    expect(applyTalkAction).toHaveBeenCalledTimes(1);
  });

  it("repeated talk/hold are idempotent (no re-execution)", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await inv.fireNotify("talk");
    await inv.fireNotify("talk"); // repeated talk in ACTIVE
    expect(applyTalkAction).not.toHaveBeenCalled();
    await inv.fireNotify("hold");
    await inv.fireNotify("hold"); // repeated hold in HELD
    expect(applyHoldAction).toHaveBeenCalledTimes(1);
  });

  it("hold while RINGING is not executed", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await inv.fireNotify("hold");
    expect(mgr.callState()).toBe(CallState.Ringing);
    expect(applyHoldAction).not.toHaveBeenCalled();
  });
});

describe("termination", () => {
  it("CANCEL while RINGING → ENDED → IDLE", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    inv.fireState("Terminated");
    expect(mgr.callState()).toBe(CallState.Ended);
    await vi.advanceTimersByTimeAsync(1100);
    expect(mgr.callState()).toBe(CallState.Idle);
  });

  it("termination while DIALING → FAILED, auto-reset ~3 s", async () => {
    autoAnswerDelay = 0;
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    inv.fireState("Terminated");
    expect(mgr.callState()).toBe(CallState.Failed);
    await vi.advanceTimersByTimeAsync(3100);
    expect(mgr.callState()).toBe(CallState.Idle);
  });

  it("BYE while ACTIVE → ENDED, and a new INVITE is accepted after reset", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await inv.fireNotify("talk");
    inv.fireState("Terminated");
    expect(mgr.callState()).toBe(CallState.Ended);
    await vi.advanceTimersByTimeAsync(1100);
    const next = makeInvitation();
    mgr.handleInvite(next);
    expect(next.rejected).toEqual([]);
    expect(mgr.callState()).toBe(CallState.Ringing);
  });
});

// Regression coverage for the post-review fixes (defects 1-4), and for the field defect
// where a RESET timer that never fired left the phone answering 486 to every dispatch.
describe("FAILED/ENDED reset window is drained lazily, not by rejecting", () => {
  it("accepts an INVITE arriving during the ENDED reset window", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await inv.fireNotify("talk"); // -> ACTIVE
    inv.fireState("Terminated"); // -> ENDED, session slot cleared but state not yet IDLE
    expect(mgr.callState()).toBe(CallState.Ended);

    const next = makeInvitation();
    mgr.handleInvite(next);
    expect(next.rejected).toEqual([]);
    expect(mgr.callState()).toBe(CallState.Ringing);
    // The state machine went through IDLE rather than skipping the RESET: an INVITE applied
    // from ENDED would have found no transition and left a phantom session behind.
    expect(states.slice(-2)).toEqual([CallState.Idle, CallState.Ringing]);

    // The drained timer must not fire later and knock the live call back to IDLE.
    await vi.advanceTimersByTimeAsync(5000);
    expect(mgr.callState()).toBe(CallState.Ringing);
  });

  it("accepts an INVITE arriving during the FAILED reset window", async () => {
    autoAnswerDelay = 0;
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    inv.fireState("Terminated"); // DIALING -> FAILED
    expect(mgr.callState()).toBe(CallState.Failed);

    autoAnswerDelay = undefined;
    const next = makeInvitation();
    mgr.handleInvite(next);
    expect(next.rejected).toEqual([]);
    expect(mgr.callState()).toBe(CallState.Ringing);

    await vi.advanceTimersByTimeAsync(5000);
    expect(mgr.callState()).toBe(CallState.Ringing);
  });

  // The field defect (aicc C37): in a backgrounded offscreen document Chrome can throttle or
  // drop the RESET setTimeout, and every later dispatch INVITE was answered 486 until the
  // WSS transport was rebuilt. No timer is advanced here at all.
  it("accepts an INVITE after a cancelled ring even if the RESET timer never fires", () => {
    const mgr = makeManager();
    const first = makeInvitation();
    mgr.handleInvite(first);
    expect(mgr.callState()).toBe(CallState.Ringing);
    first.fireState("Terminated"); // caller hung up mid-ring -> CANCEL -> ENDED
    expect(mgr.callState()).toBe(CallState.Ended);

    // Timers stay frozen: this is exactly the state Chrome leaves the document in.
    for (const _ of [0, 1, 2]) {
      const dispatch = makeInvitation();
      mgr.handleInvite(dispatch);
      expect(dispatch.rejected).toEqual([]);
      expect(mgr.callState()).toBe(CallState.Ringing);
      dispatch.fireState("Terminated");
    }
  });

  it("replies 480, not 486, when the occupied slot holds an already-terminal session", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    // accept() rejecting (mic denied) ends the call while the slot stays occupied — no
    // Terminated has arrived yet. That session is real, so the lazy RESET must not run.
    inv.accept = vi.fn(() => Promise.reject(new Error("mic denied")));
    mgr.handleInvite(inv);
    await inv.fireNotify("talk");
    expect(mgr.callState()).toBe(CallState.Ended);

    // 480, not 486: the slot is occupied but the agent is not on a call, and telling the
    // switch "busy" would both misreport the agent and pick the wrong back-off timer.
    const second = makeInvitation();
    mgr.handleInvite(second);
    expect(second.rejected).toEqual([480]);
    expect(second.accepted).toBe(0);

    // Once the invitation really does terminate, the slot clears and the next INVITE lands.
    inv.fireState("Terminated");
    const third = makeInvitation();
    mgr.handleInvite(third);
    expect(third.rejected).toEqual([]);
    expect(mgr.callState()).toBe(CallState.Ringing);
    await vi.advanceTimersByTimeAsync(5000);
  });
});

describe("a wedged session slot is discarded rather than rejected forever", () => {
  // The switch has no guard of its own: a 486 maps to USER_BUSY and does not count toward
  // mod_callcenter's max_no_answer, so a wedged phone is never rotated out. This side is the
  // only backstop, and `Terminated` is delivered by SIP.js timers in this same hidden document.
  it("accepts an INVITE once a never-terminated session has outlived the zombie threshold", async () => {
    autoAnswerDelay = 0;
    const mgr = makeManager();
    const inv = makeInvitation();
    inv.accept = vi.fn(() => Promise.reject(new Error("mic denied")));
    mgr.handleInvite(inv);
    await vi.advanceTimersByTimeAsync(10); // auto-answer runs, accept() rejects -> FAILED
    expect(mgr.callState()).toBe(CallState.Failed);

    // The reset timer carries the *state* back to IDLE while the slot stays occupied — the
    // shape the lazy drain cannot see, since that requires a null slot.
    await vi.advanceTimersByTimeAsync(3100);
    expect(mgr.callState()).toBe(CallState.Idle);

    autoAnswerDelay = undefined;
    const tooSoon = makeInvitation();
    mgr.handleInvite(tooSoon);
    expect(tooSoon.rejected).toEqual([480]);

    await vi.advanceTimersByTimeAsync(15000);
    const later = makeInvitation();
    mgr.handleInvite(later);
    expect(later.rejected).toEqual([]);
    expect(mgr.callState()).toBe(CallState.Ringing);
  });

  it("keeps rejecting while the slot has not yet outlived the threshold", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    inv.accept = vi.fn(() => Promise.reject(new Error("mic denied")));
    mgr.handleInvite(inv);
    await inv.fireNotify("talk"); // RINGING -> accept() rejects -> ENDED, slot still occupied
    expect(mgr.callState()).toBe(CallState.Ended);

    await vi.advanceTimersByTimeAsync(5000); // past the ENDED reset window, short of the threshold
    const second = makeInvitation();
    mgr.handleInvite(second);
    expect(second.rejected).toEqual([480]);
    expect(second.accepted).toBe(0);
  });

  it("never discards a slot while a call is genuinely in progress", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await inv.fireNotify("talk"); // -> ACTIVE
    await vi.advanceTimersByTimeAsync(600000); // a ten-minute call

    const second = makeInvitation();
    mgr.handleInvite(second);
    expect(second.rejected).toEqual([486]);
    expect(mgr.callState()).toBe(CallState.Active);
  });

  it("ignores a late Terminated from a session the manager no longer owns", async () => {
    const mgr = makeManager();
    const stale = makeInvitation();
    stale.accept = vi.fn(() => Promise.reject(new Error("mic denied")));
    mgr.handleInvite(stale);
    await stale.fireNotify("talk"); // -> ENDED with the slot still held by `stale`
    // The ENDED reset window elapses first (state -> IDLE, slot still held), so the zombie
    // clock runs from there; comfortably past it either way.
    await vi.advanceTimersByTimeAsync(20000);

    const live = makeInvitation();
    mgr.handleInvite(live); // discards the zombie, takes the slot
    expect(live.rejected).toEqual([]);
    expect(mgr.callState()).toBe(CallState.Ringing);

    // The discarded invitation's listener was never detached; its Terminated must not tear
    // down the call that now owns the slot.
    stale.fireState("Terminated");
    expect(mgr.callState()).toBe(CallState.Ringing);
    await live.fireNotify("talk");
    expect(mgr.callState()).toBe(CallState.Active);
  });
});

describe("RINGING+talk answer ordering (review defect 2)", () => {
  it("never reports ACTIVE if invitation.accept() rejects; state goes RINGING -> ENDED", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    inv.accept = vi.fn(() => Promise.reject(new Error("mic denied")));
    mgr.handleInvite(inv);
    expect(mgr.callState()).toBe(CallState.Ringing);

    await inv.fireNotify("talk");

    expect(states).not.toContain(CallState.Active);
    expect(states).toEqual([CallState.Ringing, CallState.Ended]);
    expect(mgr.callState()).toBe(CallState.Ended);

    // Drain the ENDED->IDLE reset timer this test triggered so it can't fire during a
    // later test and push a stray onChange into that test's (module-shared) states array.
    await vi.advanceTimersByTimeAsync(1100);
  });

  it("still reports ACTIVE once invitation.accept() resolves (success path unchanged)", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await inv.fireNotify("talk");
    expect(mgr.callState()).toBe(CallState.Active);
    expect(states).toEqual([CallState.Ringing, CallState.Active]);
    expect(inv.accepted).toBe(1);
  });
});

describe("media wiring dedup (review defect 3)", () => {
  it("registers iceconnectionstatechange exactly once across auto-answer accept() and Established", async () => {
    autoAnswerDelay = 0;
    const mgr = makeManager();
    const inv = makeInvitation();
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(public tracks: unknown[]) {}
      }
    );
    const pc = {
      getReceivers: () => [],
      addEventListener: vi.fn(),
      iceConnectionState: "connected"
    } as unknown as RTCPeerConnection;
    inv.sessionDescriptionHandler = { peerConnection: pc };

    mgr.handleInvite(inv);
    await vi.advanceTimersByTimeAsync(10); // auto-answer -> wireMedia() via answer()
    inv.fireState("Established"); // -> wireMedia() again via handleSessionState

    const iceCalls = (pc.addEventListener as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([type]) => type === "iceconnectionstatechange"
    );
    expect(iceCalls).toHaveLength(1);
  });
});

describe("terminate() clears pending reset timer (review defect 4)", () => {
  it("does not fire a late RESET onChange after terminate() during the ENDED window", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await inv.fireNotify("talk"); // -> ACTIVE
    inv.fireState("Terminated"); // -> ENDED, schedules RESET in 1000ms
    expect(mgr.callState()).toBe(CallState.Ended);

    await mgr.terminate();
    const statesAtTerminate = states.length;

    await vi.advanceTimersByTimeAsync(2000);
    // No further onChange (e.g. the RESET -> IDLE transition) should have fired: the
    // pending timer must have been cleared by terminate().
    expect(states.length).toBe(statesAtTerminate);
    expect(mgr.callState()).toBe(CallState.Ended);

    // terminate() deliberately leaves the state parked in ENDED (it runs during stop(), and
    // a teardown has no one to report an IDLE to). That must not wedge the manager: the next
    // INVITE drains the window itself. SipRuntime.start() also calls forceIdle() on restart.
    const after = makeInvitation();
    mgr.handleInvite(after);
    expect(after.rejected).toEqual([]);
    expect(mgr.callState()).toBe(CallState.Ringing);
    await vi.advanceTimersByTimeAsync(2000);
  });
});

describe("inbound ringtone (design.md §9.4)", () => {
  it("a normal INVITE starts the ringtone", () => {
    const mgr = makeManager();
    mgr.handleInvite(makeInvitation());
    expect(mgr.callState()).toBe(CallState.Ringing);
    expect(ringtone).toEqual(["start"]);
  });

  it("answer-after=0 never rings: the call goes to DIALING, not RINGING", async () => {
    autoAnswerDelay = 0;
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await vi.advanceTimersByTimeAsync(10);
    await inv.fireNotify("talk"); // DIALING -> ACTIVE
    expect(ringtone).toEqual([]);
  });

  it("answer-after=5 does not ring during the auto-answer delay either", async () => {
    autoAnswerDelay = 5;
    const mgr = makeManager();
    mgr.handleInvite(makeInvitation());
    await vi.advanceTimersByTimeAsync(6000);
    expect(ringtone).toEqual([]);
  });

  it("talk while RINGING stops the ringtone before accept(), not after ACTIVE lands", async () => {
    const events: string[] = [];
    const inv = makeInvitation();
    inv.accept = vi.fn(() => {
      events.push("accept");
      inv.accepted++;
      return Promise.resolve();
    });
    const mgr = new CallSessionManager({
      audio: {} as HTMLAudioElement,
      ringtone: { start: () => void events.push("start"), stop: () => void events.push("stop") },
      onChange: (s) => void events.push(`state:${s}`),
      onMediaFailed: () => {}
    });
    mgr.handleInvite(inv);
    await inv.fireNotify("talk");
    expect(mgr.callState()).toBe(CallState.Active);
    // The second stop is the state leaving RINGING and is deliberate: stop() is idempotent,
    // and the answer path must not wait for accept() to resolve before silencing the ring.
    expect(events).toEqual(["start", "state:RINGING", "stop", "accept", "stop", "state:ACTIVE"]);
  });

  it("CANCEL while RINGING stops the ringtone", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    inv.fireState("Terminated");
    expect(mgr.callState()).toBe(CallState.Ended);
    expect(ringtone).toEqual(["start", "stop"]);
  });

  it("a failed answer stops the ringtone", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    inv.accept = vi.fn(() => Promise.reject(new Error("mic denied")));
    mgr.handleInvite(inv);
    await inv.fireNotify("talk");
    expect(mgr.callState()).toBe(CallState.Ended);
    // stop() on issuing the answer, then again on RINGING -> ENDED; both are idempotent.
    expect(ringtone).toEqual(["start", "stop", "stop"]);
  });

  it("forceIdle() during a transport rebuild stops the ringtone", () => {
    const mgr = makeManager();
    mgr.handleInvite(makeInvitation());
    mgr.forceIdle();
    expect(mgr.callState()).toBe(CallState.Idle);
    expect(ringtone).toEqual(["start", "stop"]);
  });

  it("rings again for the call after a cancelled one", async () => {
    const mgr = makeManager();
    const first = makeInvitation();
    mgr.handleInvite(first);
    first.fireState("Terminated");
    await vi.advanceTimersByTimeAsync(2000); // drain the ENDED -> IDLE reset window
    mgr.handleInvite(makeInvitation());
    expect(ringtone).toEqual(["start", "stop", "start"]);
  });

  it("the ringtone is never started for any state other than RINGING", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await inv.fireNotify("talk"); // ACTIVE
    await inv.fireNotify("hold"); // HELD
    await inv.fireNotify("talk"); // ACTIVE
    inv.fireState("Terminated"); // ENDED
    await vi.advanceTimersByTimeAsync(2000); // IDLE
    expect(ringtone.filter((c) => c === "start")).toEqual(["start"]);
    expect(ringtone[ringtone.length - 1]).toBe("stop");
  });
});
