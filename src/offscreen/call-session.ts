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
  onChange(callState: CallState, callInProgress: boolean): void;
  onMediaFailed(reason: string): void;
}

const RESET_MS_FAILED = 3000;
const RESET_MS_ENDED = 1000;

export class CallSessionManager {
  private session: InvitationLike | null = null;
  private state: CallState = CallState.Idle;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
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
    // Only a genuinely idle manager (no session slot, and not still draining a FAILED/ENDED
    // reset window) may accept a new INVITE. `isCallInProgress` alone is not enough: the
    // session slot is already cleared on Terminated (see handleSessionState) but the state
    // machine hasn't reached IDLE yet, so without the explicit state check a second INVITE
    // during that window would be silently accepted as a phantom session.
    if (this.session !== null || this.state !== CallState.Idle) {
      diag("call", "second INVITE while session exists; replying 486");
      void invitation.reject({ statusCode: 486 }).catch(() => {});
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
    invitation.stateChange.addListener((s) => this.handleSessionState(s));
    this.apply(auto ? "INVITE_AUTO" : "INVITE_NORMAL");

    if (auto) {
      diag("call", "controlled outbound INVITE; auto-answering", { delaySeconds: delay });
      setTimeout(() => void this.answer(), (delay as number) * 1000);
    } else {
      diag("call", "normal inbound INVITE; awaiting remote answer");
    }
  }

  async terminate(): Promise<void> {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
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
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    this.session = null;
    this.mediaWired = false;
    this.setState(CallState.Idle);
  }

  private handleSessionState(s: string): void {
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

  private apply(ev: CallEvent): void {
    this.setState(transition(this.state, ev).state);
  }

  private setState(next: CallState): void {
    if (next === this.state) {
      return;
    }
    this.state = next;
    if (next === CallState.Failed || next === CallState.Ended) {
      if (this.resetTimer) {
        clearTimeout(this.resetTimer);
      }
      const ms = next === CallState.Failed ? RESET_MS_FAILED : RESET_MS_ENDED;
      this.resetTimer = setTimeout(() => this.apply("RESET"), ms);
    }
    this.deps.onChange(next, isCallInProgress(next));
  }
}
