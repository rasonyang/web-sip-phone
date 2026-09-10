import {
  applyHoldAction,
  applyTalkAction,
  BroadSoftEvent,
  getAutoAnswerDelay,
  parseEventHeaderFromNotification,
  TalkAction
} from "sip.js/lib/api/broadsoft/index.js";
import { CallState } from "../shared/state.js";
import { type CallEvent, isCallInProgress, transition } from "./call-machine.js";
import { diag } from "./diag-log.js";
import { attachRemoteAudio, MIC_CONSTRAINTS } from "./media.js";
import type { RingtonePlayer } from "./ringtone.js";

export interface NotificationLike {
  request: { getHeader(name: string): string | undefined; body: string };
  accept(): Promise<void>;
}

export interface InvitationLike {
  request: unknown;
  state: string;
  delegate?: { onNotify?: (n: NotificationLike) => void };
  stateChange: { addListener(cb: (s: string) => void): void };
  sessionDescriptionHandler?: { peerConnection?: RTCPeerConnection };
  accept(opts?: unknown): Promise<void>;
  reject(opts?: { statusCode: number }): Promise<void>;
  bye(): Promise<void>;
}

export interface CallSessionDeps {
  audio: HTMLAudioElement;
  /** Rung while, and only while, the call state is RINGING (design.md §9.4). */
  ringtone: RingtonePlayer;
  onChange(callState: CallState, callInProgress: boolean): void;
  onMediaFailed(reason: string): void;
}

const RESET_MS_FAILED = 3000;
const RESET_MS_ENDED = 1000;
/**
 * How long an occupied session slot may sit outside a call-in-progress state before the
 * session is treated as a zombie and discarded. SIP.js delivers `Terminated` within
 * milliseconds when it delivers it at all, but that delivery rides its own transaction
 * timers — setTimeouts in this same hidden document, subject to the same throttling. This
 * is the backstop for the one remaining way the slot can wedge; nothing about a live call
 * ever reaches it, because a live call is DIALING/RINGING/ACTIVE/HELD.
 */
const ZOMBIE_SLOT_MS = 15000;

export class CallSessionManager {
  private session: InvitationLike | null = null;
  private state: CallState = CallState.Idle;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  /** Epoch ms of the last state change, so a reset window can be reported as overdue. */
  private stateSince = Date.now();
  private mediaWired = false;

  constructor(private deps: CallSessionDeps) {}

  callState(): CallState {
    return this.state;
  }

  /**
   * Read-only view of the microphone track this session already captured, for level metering.
   * Never mutates the session; the meter must not open a second capture of a live device.
   */
  localAudioTrack(): MediaStreamTrack | null {
    const pc = this.session?.sessionDescriptionHandler?.peerConnection;
    const track = pc
      ?.getSenders()
      .map((s) => s.track)
      .find((t) => t?.kind === "audio");
    return track ?? null;
  }

  handleInvite(invitation: InvitationLike): void {
    // A session slot still occupied while the manager is not on a call is waiting for a
    // `Terminated` that should have arrived in milliseconds. Two paths get here: an accept()
    // that failed and whose invitation never terminated, and the same one after its reset
    // timer has already carried the state back to IDLE — that second one leaves the slot
    // occupied in IDLE, where the reset drain below can never see it. Discard it rather than
    // rejecting forever: the switch has no guard of its own against a wedged phone (verified
    // against FreeSWITCH mod_callcenter — 486 maps to USER_BUSY and does not count toward
    // `max_no_answer`), so this side is the only backstop.
    if (this.session !== null && !isCallInProgress(this.state)) {
      const elapsedMs = Date.now() - this.stateSince;
      if (elapsedMs > ZOMBIE_SLOT_MS) {
        diag("call", "session slot still occupied long after the call ended; discarding zombie", {
          state: this.state,
          elapsedMs,
          thresholdMs: ZOMBIE_SLOT_MS
        });
        this.forceIdle();
      }
    }

    // A manager parked in FAILED/ENDED with its session slot already cleared holds nothing
    // worth protecting: it is only waiting out the cosmetic reset window. Run that RESET
    // here rather than rejecting. Correctness must not depend on `resetTimer` firing — it
    // is a setTimeout in a background offscreen document, which Chrome may throttle to the
    // one-minute grid or drop entirely, and a RESET that never ran used to leave the phone
    // answering 486 to every subsequent INVITE until the transport was rebuilt. Doing it
    // lazily also removes the legitimate-but-costly 1s/3s window in which a queue dispatch
    // landing on a just-ended call was rejected (see docs/KNOWN-LIMITATIONS.md).
    if (this.session === null && (this.state === CallState.Ended || this.state === CallState.Failed)) {
      // `overdueBy` is the forensic value: a positive number means the reset timer was due and
      // never ran, i.e. the document's timers were throttled or dropped while it was hidden.
      const windowMs = this.state === CallState.Failed ? RESET_MS_FAILED : RESET_MS_ENDED;
      const elapsedMs = Date.now() - this.stateSince;
      diag("call", `INVITE during the ${this.state} reset window; resetting instead of rejecting`, {
        elapsedMs,
        windowMs,
        overdueByMs: Math.max(0, elapsedMs - windowMs)
      });
      this.clearResetTimer();
      this.apply("RESET");
    }

    // Only a genuinely idle manager may accept a new INVITE. `isCallInProgress` alone is not
    // enough: an accept() that failed (e.g. mic denied) lands in a terminal state — FAILED
    // from the auto-answer path, ENDED from RINGING+talk — with the session slot still
    // occupied, and that session must not be replaced by a phantom one.
    if (this.session !== null || this.state !== CallState.Idle) {
      // 486 means "this person is on a call" — only say that when it is true. A slot still
      // occupied by a terminal session (accept() failed, Terminated not delivered yet) is a
      // sub-second race in which the agent is not talking to anyone, and a switch that routes
      // 486 to its busy timer would both misreport the agent as busy and apply the wrong
      // penalty; 480 Temporarily Unavailable is what actually happened.
      const statusCode = isCallInProgress(this.state) ? 486 : 480;
      diag("call", `second INVITE while session exists; replying ${statusCode}`, { state: this.state });
      void invitation.reject({ statusCode }).catch(() => {});
      return;
    }

    const delay = getAutoAnswerDelay(invitation.request as never);
    const auto = delay !== undefined && Number.isFinite(delay) && delay >= 0;
    if (delay !== undefined && !auto) {
      diag("call", "Answer-After present but invalid; treating as normal inbound", { delay });
    }

    this.session = invitation;
    this.mediaWired = false;
    invitation.delegate = { onNotify: (n) => void this.handleNotify(n) };
    invitation.stateChange.addListener((s) => this.handleSessionState(invitation, s));
    this.apply(auto ? "INVITE_AUTO" : "INVITE_NORMAL");

    if (auto) {
      diag("call", "controlled outbound INVITE; auto-answering", { delaySeconds: delay });
      setTimeout(() => void this.answer(), (delay as number) * 1000);
    } else {
      diag("call", "normal inbound INVITE; awaiting remote answer");
    }
  }

  async terminate(): Promise<void> {
    this.clearResetTimer();
    const s = this.session;
    if (!s) {
      return;
    }
    try {
      if (s.state === "Established") {
        await s.bye();
      } else if (s.state === "Initial") {
        await s.reject({ statusCode: 480 });
      }
    } catch (e) {
      diag("call", "terminate failed", { error: String(e) });
    }
  }

  private async answer(): Promise<void> {
    const s = this.session;
    if (!s || s.state !== "Initial") {
      return;
    }
    try {
      await s.accept({ sessionDescriptionHandlerOptions: { constraints: MIC_CONSTRAINTS } });
      this.wireMedia();
    } catch (e) {
      // Never fake a successful answer: accept() failing (e.g. mic denied) fails the call.
      diag("call", "accept failed", { error: String(e) });
      this.apply("FAIL");
    }
  }

  private async handleNotify(n: NotificationLike): Promise<void> {
    const eventType = parseEventHeaderFromNotification(n as never);
    if (eventType === undefined) {
      diag("broadsoft", "non-BroadSoft NOTIFY accepted and ignored");
      await n.accept();
      return;
    }
    const ev: CallEvent = eventType === BroadSoftEvent.Hold ? "HOLD" : "TALK";
    const from = this.state;
    const { state, execute } = transition(from, ev);
    diag("broadsoft", `NOTIFY ${eventType} in ${from}`, { next: state, execute });

    // RINGING+talk answers the call: never fake a successful answer by reporting ACTIVE
    // before invitation.accept() actually resolves. Every other transition (HOLD,
    // HELD→ACTIVE resume, and all no-op/idempotent cases) still applies its state change
    // immediately, since those don't depend on a SIP action succeeding first.
    const answerBeforeActive = execute && ev === "TALK" && from === CallState.Ringing;
    if (!answerBeforeActive) {
      this.setState(state);
    }
    await n.accept();

    if (!execute) {
      return;
    }
    const s = this.session;
    if (!s) {
      return;
    }
    try {
      if (ev === "HOLD") {
        await applyHoldAction(s as never);
      } else if (answerBeforeActive) {
        // The state deliberately stays RINGING until accept() resolves (see above), which
        // takes as long as ICE gathering: stop the ringtone here instead of waiting for the
        // state to leave RINGING, or it would still be ringing over the caller's audio.
        this.deps.ringtone.stop();
        await s.accept({ sessionDescriptionHandlerOptions: { constraints: MIC_CONSTRAINTS } });
        this.setState(CallState.Active);
        this.wireMedia();
      } else {
        // HELD → ACTIVE resume: re-INVITE with sendrecv.
        await applyTalkAction(s as never, TalkAction.Talk);
      }
    } catch (e) {
      diag("broadsoft", "apply action failed", { event: ev, error: String(e) });
      if (answerBeforeActive) {
        this.apply("FAIL");
      }
    }
  }

  /**
   * Discard any session without signaling. Used when the transport is being rebuilt: the
   * old dialogs are bound to the dead connection (FreeSWITCH routes them via fs_path), so
   * a BYE could never be delivered anyway and the manager must be free to accept the next
   * INVITE that arrives on the new transport.
   */
  forceIdle(): void {
    this.clearResetTimer();
    this.session = null;
    this.mediaWired = false;
    this.setState(CallState.Idle);
  }

  private handleSessionState(invitation: InvitationLike, s: string): void {
    // The listener is never detached, so an invitation dropped without signaling — by
    // forceIdle() during a transport rebuild, or by the zombie discard above — can still
    // deliver a late `Terminated`. Without this check it would clear the slot and apply a
    // CANCEL/BYE against whatever call is live by then, tearing down an unrelated session.
    if (this.session !== invitation) {
      diag("call", `ignoring ${s} from a session this manager no longer owns`);
      return;
    }
    if (s === "Established") {
      this.wireMedia();
      return;
    }
    if (s !== "Terminated") {
      return;
    }
    const ev: CallEvent =
      this.state === CallState.Dialing ? "FAIL" : this.state === CallState.Ringing ? "CANCEL" : "BYE";
    diag("call", `session terminated in ${this.state}`, { mappedEvent: ev });
    this.session = null;
    this.mediaWired = false;
    this.apply(ev);
  }

  private wireMedia(): void {
    // handleSessionState's Established branch and the various accept() call sites can both
    // reach here for the same session; guard so media is attached and listeners register
    // exactly once per session. Reset alongside the session slot (handleInvite/handleSessionState).
    if (this.mediaWired) {
      return;
    }
    const pc = this.session?.sessionDescriptionHandler?.peerConnection;
    if (!pc) {
      return;
    }
    this.mediaWired = true;
    attachRemoteAudio(pc, this.deps.audio);
    pc.addEventListener("iceconnectionstatechange", () => {
      if (pc.iceConnectionState === "failed") {
        diag("media", "ICE connection failed");
        this.deps.onMediaFailed("ICE connection failed");
      }
    });
  }

  private clearResetTimer(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  private apply(ev: CallEvent): void {
    this.setState(transition(this.state, ev).state);
  }

  private setState(next: CallState): void {
    if (next === this.state) {
      return;
    }
    const wasRinging = this.state === CallState.Ringing;
    this.state = next;
    this.stateSince = Date.now();
    // Every path in and out of RINGING funnels through here — INVITE, Talk, CANCEL, BYE,
    // FAIL, RESET and forceIdle() — so this is the one place the ringtone has to be driven.
    if (next === CallState.Ringing) {
      this.deps.ringtone.start();
    } else if (wasRinging) {
      this.deps.ringtone.stop();
    }
    if (next === CallState.Failed || next === CallState.Ended) {
      this.clearResetTimer();
      const ms = next === CallState.Failed ? RESET_MS_FAILED : RESET_MS_ENDED;
      // Best-effort only: the same RESET is applied lazily by handleInvite, so a beat that
      // Chrome throttles away costs nothing beyond a late status broadcast.
      this.resetTimer = setTimeout(() => this.apply("RESET"), ms);
    }
    this.deps.onChange(next, isCallInProgress(next));
  }
}
