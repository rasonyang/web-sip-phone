import { CallState } from "../shared/state.js";

export type CallEvent = "INVITE_AUTO" | "INVITE_NORMAL" | "TALK" | "HOLD" | "CANCEL" | "BYE" | "FAIL" | "RESET";

export interface Transition {
  state: CallState;
  /** Whether the glue should perform the SIP action (accept / re-INVITE). */
  execute: boolean;
}

// Single source of truth for call-state transitions (design.md §10, §13.3).
// Missing entries mean: stay in the current state, execute nothing.
const TABLE: Partial<Record<CallState, Partial<Record<CallEvent, Transition>>>> = {
  [CallState.Idle]: {
    INVITE_AUTO: { state: CallState.Dialing, execute: true },
    INVITE_NORMAL: { state: CallState.Ringing, execute: false }
  },
  [CallState.Dialing]: {
    TALK: { state: CallState.Active, execute: false },
    CANCEL: { state: CallState.Ended, execute: false },
    BYE: { state: CallState.Failed, execute: false },
    FAIL: { state: CallState.Failed, execute: false }
  },
  [CallState.Ringing]: {
    TALK: { state: CallState.Active, execute: true },
    CANCEL: { state: CallState.Ended, execute: false },
    FAIL: { state: CallState.Ended, execute: false }
  },
  [CallState.Active]: {
    HOLD: { state: CallState.Held, execute: true },
    BYE: { state: CallState.Ended, execute: false },
    FAIL: { state: CallState.Ended, execute: false }
  },
  [CallState.Held]: {
    TALK: { state: CallState.Active, execute: true },
    BYE: { state: CallState.Ended, execute: false },
    FAIL: { state: CallState.Ended, execute: false }
  },
  [CallState.Failed]: {
    RESET: { state: CallState.Idle, execute: false }
  },
  [CallState.Ended]: {
    RESET: { state: CallState.Idle, execute: false }
  }
};

export function transition(current: CallState, event: CallEvent): Transition {
  return TABLE[current]?.[event] ?? { state: current, execute: false };
}

export function isCallInProgress(state: CallState): boolean {
  return (
    state === CallState.Dialing || state === CallState.Ringing || state === CallState.Active || state === CallState.Held
  );
}
