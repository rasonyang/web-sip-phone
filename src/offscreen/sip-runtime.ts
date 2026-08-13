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
  /** Raw inbound SIP message from the transport; feeds the liveness watchdog. */
  onTransportMessage(message: string): void;
}

export interface UaFactory {
  create(config: RuntimeConfig, delegate: UaDelegate): { ua: UaLike; registerer: RegistererLike };
}

const MAX_BACKOFF_MS = 30000;
const PERSISTENT_FAILURE_ATTEMPTS = 5;
// Random jitter (0..30% on top of the base delay) spreads reconnect storms: after a server
// restart or network blip every client's backoff ladder starts at the same instant, and
// without jitter they all hammer the server in lockstep at 1s, 2s, 4s…
const BACKOFF_JITTER_FACTOR = 0.3;

/** 1s → 2s → 4s → 8s → 16s → 30s (cap), plus 0..30% random jitter. */
function backoffDelayMs(attempts: number): number {
  const base = Math.min(1000 * 2 ** attempts, MAX_BACKOFF_MS);
  return base + Math.random() * base * BACKOFF_JITTER_FACTOR;
}
// A reconnect attempt that neither resolves nor rejects within this window is treated as
// wedged. This happens after system sleep: SIP.js's own connectionTimeout is a setTimeout
// that gets suspended with the machine, and its transport returns the same never-settling
// connect promise to every subsequent connect() call, so without an external timeout one
// zombie attempt would block reconnection forever.
const RECONNECT_ATTEMPT_TIMEOUT_MS = 15000;
// Liveness watchdog. FreeSWITCH pings every registered contact with OPTIONS on a fixed
// cadence (~30s with nat-options-ping / all-reg-options-ping); once those pings have been
// observed, prolonged silence proves the socket is dead even though the browser cannot see
// it (send() on a half-open TCP connection never fails, and no close event ever fires for a
// connection orphaned by system sleep). Three missed cadences — never less than 90s so a
// single delayed ping can't trip it — triggers a full resync. Deployments that never send
// OPTIONS never arm the watchdog, so registration-refresh-only silence stays legal.
const LIVENESS_FLOOR_MS = 90000;
const LIVENESS_GAP_MULTIPLIER = 3;
// A failed REGISTER (rejected or send error) must never be terminal: the cause is usually
// transient (server restart, post-sleep flap, stale nonce), and if it truly is bad
// credentials the periodic retry is harmless while the error card keeps telling the user.
const REGISTER_RETRY_MS = 30000;

class ReconnectTimeoutError extends Error {
  constructor() {
    super(`reconnect attempt exceeded ${RECONNECT_ATTEMPT_TIMEOUT_MS}ms`);
  }
}

function withAttemptTimeout(op: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReconnectTimeoutError()), RECONNECT_ATTEMPT_TIMEOUT_MS);
    op.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export class SipRuntime {
  private ua: UaLike | null = null;
  private registerer: RegistererLike | null = null;
  private sessions: CallSessionManager;
  private phase: Phase = "stopped";
  private errors = new Set<ErrorCode>();
  private reconnecting = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private registerRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private callInProgress = false;
  private micOk = false;
  /** Config the runtime was started with; needed to rebuild the UA after a wedged transport. */
  private config: RuntimeConfig | null = null;
  /** True while the current UA instance has never been start()ed — reconnect() on a fresh UA rejects. */
  private uaNeedsStart = false;
  // Liveness watchdog state, reset with every new transport (createUa).
  private lastInboundMs = 0;
  private lastOptionsMs: number | null = null;
  private optionsGapMs: number | null = null;
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
      // A redundant start arrives whenever the MV3 service worker is killed and restarted:
      // its in-memory status copy is gone (it renders "Connecting…" until told otherwise)
      // and a steady runtime reports nothing on its own. Replay the current status so the
      // restarted worker resynchronizes instead of displaying a stale connecting state.
      this.report();
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

    this.config = config;
    this.createUa(config);
    const ua = this.ua!;

    try {
      await ua.start();
      this.uaNeedsStart = false;
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
            this.scheduleRegisterRetry(gen);
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
        this.scheduleRegisterRetry(gen);
      });
  }

  private scheduleRegisterRetry(gen: number): void {
    if (this.registerRetryTimer) {
      clearTimeout(this.registerRetryTimer);
    }
    // Same jitter rationale as the reconnect ladder: after a server restart, every client's
    // failed registration would otherwise retry on the same 30s beat.
    const delay = REGISTER_RETRY_MS + Math.random() * REGISTER_RETRY_MS * BACKOFF_JITTER_FACTOR;
    this.registerRetryTimer = setTimeout(() => {
      this.registerRetryTimer = null;
      if (!this.running || gen !== this.generation || this.phase === "ready") {
        return;
      }
      diag("sip", "retrying REGISTER after failure");
      void this.register(gen);
    }, delay);
  }

  private createUa(config: RuntimeConfig): void {
    const { ua, registerer } = this.deps.factory.create(config, {
      onConnect: () => {},
      onDisconnect: (error) => this.handleDisconnect(error),
      onInvite: (invitation) => this.sessions.handleInvite(invitation as InvitationLike),
      onTransportMessage: (message) => this.noteInboundMessage(message)
    });
    this.ua = ua;
    this.registerer = registerer;
    this.uaNeedsStart = true;
    // Fresh transport: restart the liveness clock and re-learn the server's ping cadence
    // (a gap measured across the rebuild would span the dead period and inflate the threshold).
    this.lastInboundMs = Date.now();
    this.lastOptionsMs = null;
    this.optionsGapMs = null;
  }

  private noteInboundMessage(message: string): void {
    const now = Date.now();
    this.lastInboundMs = now;
    if (message.startsWith("OPTIONS ")) {
      if (this.lastOptionsMs !== null) {
        this.optionsGapMs = now - this.lastOptionsMs;
      }
      this.lastOptionsMs = now;
    }
  }

  /**
   * Called on the offscreen heartbeat. When the server's OPTIONS pings have been observed
   * on this transport and then go silent for several cadences, the socket is dead no matter
   * what the runtime believes — force a resync.
   */
  checkLiveness(now = Date.now()): void {
    // Armed in "registering" too: a registration stuck failing because the socket died
    // (the server only pings registered contacts, so the silence is real) must also resync.
    const connectedPhase = this.phase === "ready" || this.phase === "registering";
    if (!this.running || !connectedPhase || this.reconnecting || this.lastOptionsMs === null) {
      return;
    }
    const threshold = Math.max(LIVENESS_FLOOR_MS, (this.optionsGapMs ?? 0) * LIVENESS_GAP_MULTIPLIER);
    const silence = now - this.lastInboundMs;
    if (silence > threshold) {
      diag("sip", "liveness watchdog: server ping silence, transport presumed dead", {
        silenceMs: silence,
        thresholdMs: threshold
      });
      this.resync();
    }
  }

  /**
   * Replace a wedged UA with a fresh one. SIP.js's transport hands the same never-settling
   * connect promise to every connect() call once an attempt is stuck (e.g. a socket orphaned
   * by system sleep), so a new UA/Transport — and with it a new WebSocket — is the only way
   * out. The old UA is stopped best-effort in the background.
   */
  private rebuildUa(): void {
    const old = this.ua;
    this.ua = null;
    this.registerer = null;
    void old?.stop().catch(() => {});
    // Any session belongs to the old transport (FreeSWITCH routes its dialogs via the dead
    // connection's fs_path), so it is unrecoverable: discard it without signaling so the
    // manager can accept the next INVITE arriving on the new transport.
    this.sessions.forceIdle();
    if (this.running && this.config) {
      this.createUa(this.config);
    }
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
    // Explicit delays (retry()/resync()/queued follow-ups pass 0) stay exact; only the
    // automatic backoff ladder gets jitter.
    const delay = delayMs ?? backoffDelayMs(this.attempts);
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
      // A rebuilt UA has never been started; reconnect() on it would reject immediately.
      await withAttemptTimeout(this.uaNeedsStart ? this.ua.start() : this.ua.reconnect());
      if (gen !== this.generation) {
        return; // stop()/a newer start() ran while reconnect() was pending; ua is already torn down
      }
      this.uaNeedsStart = false;
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
      if (e instanceof ReconnectTimeoutError) {
        // The transport is wedged; retrying on it would await the same dead promise forever.
        this.rebuildUa();
      }
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

  /**
   * Force a full transport rebuild and re-registration, regardless of what state the runtime
   * believes it is in. Used after suspected system sleep or a network change: the socket may
   * be a zombie the browser cannot detect (send() on a half-open TCP connection does not
   * fail), the server may have expired the registration while we were suspended, and any
   * in-flight connect promise may be permanently wedged. None of that state can be trusted,
   * so it is all discarded.
   */
  resync(): void {
    if (!this.running) {
      return;
    }
    diag("sip", "resync: rebuilding transport after suspend/network change");
    // Invalidate any in-flight attempt/register continuation before tearing the UA down,
    // exactly like stop()/start() do, so a wedged attempt's late timeout cannot double-rebuild.
    this.generation++;
    this.reconnecting = true;
    this.attempts = 0;
    this.report();
    this.rebuildUa();
    this.scheduleReconnect(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    const gen = ++this.generation;
    this.attemptQueued = false;
    this.config = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.registerRetryTimer) {
      clearTimeout(this.registerRetryTimer);
      this.registerRetryTimer = null;
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
