import type { OffscreenStatus, Phase, RuntimeConfig } from "../shared/messages.js";
import type { ErrorCode, LinkStatus } from "../shared/state.js";
import { CallState } from "../shared/state.js";
import { CallSessionManager, type InvitationLike } from "./call-session.js";
import { diag } from "./diag-log.js";
import { probeMicPermission } from "./media.js";

export interface UaLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  reconnect(): Promise<void>;
}

export interface RegistererLike {
  register(opts?: { requestDelegate?: { onAccept?: () => void; onReject?: () => void } }): Promise<unknown>;
  unregister(): Promise<unknown>;
}

export interface UaDelegate {
  onConnect(): void;
  onDisconnect(error?: Error): void;
  onInvite(invitation: unknown): void;
}

export interface UaFactory {
  create(config: RuntimeConfig, delegate: UaDelegate): { ua: UaLike; registerer: RegistererLike };
}

const MAX_BACKOFF_MS = 30000;
const PERSISTENT_FAILURE_ATTEMPTS = 5;

export class SipRuntime {
  private ua: UaLike | null = null;
  private registerer: RegistererLike | null = null;
  private sessions: CallSessionManager;
  private phase: Phase = "stopped";
  private errors = new Set<ErrorCode>();
  private reconnecting = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private callInProgress = false;
  private micOk = false;
  // Guards against races between start()/stop()/attemptReconnect(): each async continuation
  // captures the generation it began under and bails out if a later start()/stop() call has
  // since superseded it (bumped this.generation), rather than mutating stale/torn-down state.
  private generation = 0;
  // Ensures at most one reconnect() call is ever in flight at a time (retry()/a fresh
  // onDisconnect while an attempt is already running queue a single follow-up instead of
  // racing a second reconnect()/register() pair against the first).
  private attemptInFlight = false;
  private attemptQueued = false;

  constructor(private deps: { factory: UaFactory; audio: HTMLAudioElement; onStatus(s: OffscreenStatus): void }) {
    this.sessions = new CallSessionManager({
      audio: deps.audio,
      onChange: (state, inProgress) => {
        this.callInProgress = inProgress;
        if (state === CallState.Dialing || state === CallState.Ringing) {
          this.errors.delete("MEDIA_FAILED"); // new call: previous media failure no longer current
        }
        this.report();
      },
      onMediaFailed: () => {
        this.errors.add("MEDIA_FAILED");
        this.report();
      }
    });
  }

  async start(config: RuntimeConfig): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.errors.clear();
    this.attemptQueued = false;
    const gen = ++this.generation;

    const mic = await probeMicPermission();
    if (gen !== this.generation) {
      return; // superseded by a subsequent stop()/start() while the mic probe was pending
    }
    this.micOk = mic === "granted";
    if (!this.micOk) {
      // Design §6.1: the SIP runtime starts only when the microphone is available.
      this.errors.add("MICROPHONE_BLOCKED");
      this.phase = "stopped";
      this.running = false;
      this.report();
      return;
    }

    this.phase = "connecting";
    this.report();

    const { ua, registerer } = this.deps.factory.create(config, {
      onConnect: () => {},
      onDisconnect: (error) => this.handleDisconnect(error),
      onInvite: (invitation) => this.sessions.handleInvite(invitation as InvitationLike)
    });
    this.ua = ua;
    this.registerer = registerer;

    try {
      await ua.start();
    } catch (e) {
      if (gen !== this.generation) {
        return;
      }
      diag("sip", "transport connect failed", { error: String(e) });
      this.handleDisconnect(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (gen !== this.generation) {
      return; // stop()/a newer start() ran while ua.start() was pending; don't resurrect state
    }
    this.phase = "registering";
    this.report();
    await this.register(gen);
  }

  // `gen` is the generation captured by the caller (start()/attemptReconnect()) before this
  // REGISTER was sent. A stop() (or a newer start()) can bump this.generation while the
  // REGISTER is still in flight; when its callbacks/rejection finally arrive, they must not
  // resurrect phase/errors for a runtime instance that has since been torn down or restarted.
  private async register(gen: number): Promise<void> {
    await this.registerer
      ?.register({
        requestDelegate: {
          onAccept: () => {
            if (gen !== this.generation) {
              return; // stale: superseded by stop()/a newer start() while REGISTER was pending
            }
            this.phase = "ready";
            this.errors.delete("REGISTRATION_FAILED");
            this.errors.delete("CONNECTION_LOST");
            this.reconnecting = false;
            this.attempts = 0;
            this.report();
          },
          onReject: () => {
            if (gen !== this.generation) {
              return;
            }
            diag("sip", "REGISTER rejected");
            this.errors.add("REGISTRATION_FAILED");
            // Never leave a stale "ready" behind a rejected re-register.
            this.phase = "registering";
            this.report();
          }
        }
      })
      .catch((e) => {
        if (gen !== this.generation) {
          return;
        }
        diag("sip", "REGISTER send failed", { error: String(e) });
        this.errors.add("REGISTRATION_FAILED");
        this.phase = "registering";
        this.report();
      });
  }

  private handleDisconnect(error?: Error): void {
    if (!this.running || !error) {
      return; // graceful disconnect during stop()
    }
    diag("sip", "WSS disconnected", { error: String(error) });
    this.reconnecting = true;
    this.report();
    this.scheduleReconnect();
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    const delay = delayMs ?? Math.min(1000 * 2 ** this.attempts, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => void this.attemptReconnect(), delay);
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.running || !this.ua) {
      return;
    }
    if (this.attemptInFlight) {
      // Another attempt (from a fresh onDisconnect or retry()) is already running; fold this
      // request into a single follow-up run once the in-flight one settles instead of racing
      // a second reconnect()/register() pair against it.
      this.attemptQueued = true;
      return;
    }
    this.attemptInFlight = true;
    const gen = this.generation;
    try {
      await this.ua.reconnect();
      if (gen !== this.generation) {
        return; // stop()/a newer start() ran while reconnect() was pending; ua is already torn down
      }
      this.phase = "registering";
      this.report();
      await this.register(gen);
      if (gen === this.generation) {
        // Only "reconnecting" while the WSS transport itself is being re-established; once
        // ua.reconnect() succeeded and register() has settled (accepted or rejected) the
        // transport-level reconnect is over, independent of the registration outcome.
        this.reconnecting = false;
        this.report();
      }
    } catch (e) {
      if (gen !== this.generation) {
        return;
      }
      this.attempts++;
      diag("sip", "reconnect attempt failed", { attempt: this.attempts, error: String(e) });
      if (this.attempts >= PERSISTENT_FAILURE_ATTEMPTS) {
        this.errors.add("CONNECTION_LOST");
      }
      this.report();
      this.scheduleReconnect(); // keep trying while an allow site exists (SW stops us otherwise)
    } finally {
      this.attemptInFlight = false;
      if (this.attemptQueued && this.running) {
        this.attemptQueued = false;
        this.scheduleReconnect(0);
      }
    }
  }

  retry(): void {
    if (!this.running) {
      return;
    }
    this.attempts = 0;
    this.scheduleReconnect(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    const gen = ++this.generation;
    this.attemptQueued = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Capture and detach the current UA/registerer synchronously (before any await) so a
    // fresh start() that races this stop() gets its own instances immediately and can never
    // have them yanked out from under it by this call's teardown finishing later.
    const ua = this.ua;
    const registerer = this.registerer;
    this.ua = null;
    this.registerer = null;

    // Order per design §6.4: end call → unregister (Expires 0) → close WSS.
    await this.sessions.terminate();
    try {
      await registerer?.unregister();
    } catch (e) {
      diag("sip", "unregister failed", { error: String(e) });
    }
    try {
      await ua?.stop();
    } catch (e) {
      diag("sip", "UA stop failed", { error: String(e) });
    }

    if (gen !== this.generation) {
      return; // a newer start()/stop() has since run; don't clobber its state with ours
    }
    this.phase = "stopped";
    this.errors.clear();
    this.reconnecting = false;
    this.callInProgress = false;
    this.report();
  }

  private link(): LinkStatus {
    const regFailed = this.errors.has("REGISTRATION_FAILED");
    const up = this.phase === "ready" && !this.reconnecting && !regFailed;
    return {
      registration: regFailed ? "down" : up ? "up" : this.phase === "registering" ? "connecting" : "down",
      websocket: this.reconnecting ? "connecting" : this.phase === "stopped" ? "down" : "up",
      microphone: this.micOk ? "ok" : this.errors.has("MICROPHONE_BLOCKED") ? "blocked" : "unknown",
      media: this.errors.has("MEDIA_FAILED") ? "failed" : this.callInProgress ? "ok" : "idle"
    };
  }

  private report(): void {
    this.deps.onStatus({
      phase: this.phase,
      errors: [...this.errors],
      reconnecting: this.reconnecting,
      link: this.link(),
      callInProgress: this.callInProgress
    });
  }
}
