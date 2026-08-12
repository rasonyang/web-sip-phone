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

function makeManager() {
  states = [];
  mediaFailed = 0;
  return new CallSessionManager({
    audio: {} as HTMLAudioElement,
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

// Regression coverage for the post-review fixes (defects 1-4).
describe("486 defense - FAILED/ENDED reset window (review defect 1)", () => {
  it("rejects an INVITE arriving during the ENDED reset window; a later INVITE after reset is accepted", async () => {
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    await inv.fireNotify("talk"); // -> ACTIVE
    inv.fireState("Terminated"); // -> ENDED, session slot cleared but state not yet IDLE
    expect(mgr.callState()).toBe(CallState.Ended);

    const phantom = makeInvitation();
    mgr.handleInvite(phantom);
    expect(phantom.rejected).toEqual([486]);
    expect(phantom.accepted).toBe(0);

    // The phantom must not have occupied the session slot: advancing time must not
    // auto-answer it, and once the reset window elapses a real INVITE is accepted.
    await vi.advanceTimersByTimeAsync(1100);
    expect(mgr.callState()).toBe(CallState.Idle);
    expect(phantom.accepted).toBe(0);

    const legit = makeInvitation();
    mgr.handleInvite(legit);
    expect(legit.rejected).toEqual([]);
    expect(mgr.callState()).toBe(CallState.Ringing);
  });

  it("rejects an INVITE arriving during the FAILED reset window", async () => {
    autoAnswerDelay = 0;
    const mgr = makeManager();
    const inv = makeInvitation();
    mgr.handleInvite(inv);
    inv.fireState("Terminated"); // DIALING -> FAILED
    expect(mgr.callState()).toBe(CallState.Failed);

    const phantom = makeInvitation();
    mgr.handleInvite(phantom);
    expect(phantom.rejected).toEqual([486]);

    await vi.advanceTimersByTimeAsync(3100);
    expect(mgr.callState()).toBe(CallState.Idle);
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
  });
});
