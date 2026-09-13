import type { Msg } from "../shared/messages.js";

const INVALIDATED = "Extension context invalidated";

export function isContextInvalidatedError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return message.includes(INVALIDATED);
}

/**
 * The content script's only way into `chrome.runtime`.
 *
 * When the extension is reloaded, updated or disabled, a content script already running in an
 * open tab is orphaned: its JavaScript keeps running, but `chrome.runtime.id` goes undefined and
 * `chrome.runtime.sendMessage` throws "Extension context invalidated" *synchronously*, so a
 * `.catch()` on the returned promise never sees it. Every call therefore goes through here, and
 * the first sign of an invalidated context — a missing id, a synchronous throw, or a rejection
 * carrying that message — fires `onInvalidated` exactly once.
 */
export interface RuntimeGuard {
  /** False once the context is gone. Checking it is itself a detection point. */
  alive(): boolean;
  /** Fire-and-forget to the service worker. */
  send(msg: Msg): void;
  /**
   * Ask the service worker. `{ reply }` is an answer (which may itself be `undefined`); `null` is
   * no answer at all — a sleeping or missing worker, or an invalidated context.
   */
  request(msg: Msg): Promise<{ reply: unknown } | null>;
  /** Run any other `chrome.*` access; returns `fallback` if the context is gone or it throws. */
  call<T>(fn: () => T, fallback: T): T;
}

export function createRuntimeGuard(onInvalidated: () => void): RuntimeGuard {
  let dead = false;
  const die = (): void => {
    if (!dead) {
      dead = true;
      onInvalidated();
    }
  };
  const alive = (): boolean => {
    if (dead) {
      return false;
    }
    let id: string | undefined;
    try {
      id = chrome.runtime?.id;
    } catch {
      id = undefined;
    }
    if (!id) {
      die();
      return false;
    }
    return true;
  };
  // Only an invalidation message or a vanished id is fatal; any other failure is an ordinary
  // unreachable worker and leaves the instance running.
  const onError = (e: unknown): void => {
    if (isContextInvalidatedError(e)) {
      die();
    } else {
      alive();
    }
  };
  const request = (msg: Msg): Promise<{ reply: unknown } | null> => {
    if (!alive()) {
      return Promise.resolve(null);
    }
    let pending: Promise<unknown>;
    try {
      pending = chrome.runtime.sendMessage(msg);
    } catch (e) {
      onError(e);
      return Promise.resolve(null);
    }
    return Promise.resolve(pending).then(
      (reply) => ({ reply }),
      (e: unknown) => {
        onError(e);
        return null;
      }
    );
  };
  return {
    alive,
    send: (msg) => void request(msg),
    request,
    call: (fn, fallback) => {
      if (!alive()) {
        return fallback;
      }
      try {
        return fn();
      } catch (e) {
        onError(e);
        return fallback;
      }
    }
  };
}
