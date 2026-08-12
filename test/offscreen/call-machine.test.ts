import { describe, expect, it } from "vitest";
import { CallState } from "../../src/shared/state.js";
import { isCallInProgress, transition } from "../../src/offscreen/call-machine.js";

const t = (s: CallState, e: Parameters<typeof transition>[1]) => transition(s, e);

describe("call state machine", () => {
  it("READY(IDLE) → DIALING on controlled outbound INVITE", () => {
    expect(t(CallState.Idle, "INVITE_AUTO")).toEqual({ state: CallState.Dialing, execute: true });
  });
  it("READY(IDLE) → RINGING on normal INVITE", () => {
    expect(t(CallState.Idle, "INVITE_NORMAL")).toEqual({ state: CallState.Ringing, execute: false });
  });
  it("DIALING → ACTIVE on talk (no SIP action; leg already answered)", () => {
    expect(t(CallState.Dialing, "TALK")).toEqual({ state: CallState.Active, execute: false });
  });
  it("RINGING → ACTIVE on talk (answer the INVITE)", () => {
    expect(t(CallState.Ringing, "TALK")).toEqual({ state: CallState.Active, execute: true });
  });
  it("ACTIVE → HELD on hold (re-INVITE sendonly)", () => {
    expect(t(CallState.Active, "HOLD")).toEqual({ state: CallState.Held, execute: true });
  });
  it("HELD → ACTIVE on talk (re-INVITE sendrecv)", () => {
    expect(t(CallState.Held, "TALK")).toEqual({ state: CallState.Active, execute: true });
  });
  it("DIALING → FAILED on failure", () => {
    expect(t(CallState.Dialing, "FAIL")).toEqual({ state: CallState.Failed, execute: false });
  });
  it("RINGING → ENDED on CANCEL", () => {
    expect(t(CallState.Ringing, "CANCEL")).toEqual({ state: CallState.Ended, execute: false });
  });
  it("ACTIVE → ENDED on BYE", () => {
    expect(t(CallState.Active, "BYE")).toEqual({ state: CallState.Ended, execute: false });
  });
  it("HELD → ENDED on BYE", () => {
    expect(t(CallState.Held, "BYE")).toEqual({ state: CallState.Ended, execute: false });
  });
  it("repeated talk in ACTIVE is idempotent success, not re-executed", () => {
    expect(t(CallState.Active, "TALK")).toEqual({ state: CallState.Active, execute: false });
  });
  it("repeated hold in HELD is idempotent success, not re-executed", () => {
    expect(t(CallState.Held, "HOLD")).toEqual({ state: CallState.Held, execute: false });
  });
  it("hold in RINGING, DIALING, ENDED is not executed", () => {
    expect(t(CallState.Ringing, "HOLD")).toEqual({ state: CallState.Ringing, execute: false });
    expect(t(CallState.Dialing, "HOLD")).toEqual({ state: CallState.Dialing, execute: false });
    expect(t(CallState.Ended, "HOLD")).toEqual({ state: CallState.Ended, execute: false });
  });
  it("talk in ENDED / IDLE is ignored", () => {
    expect(t(CallState.Ended, "TALK")).toEqual({ state: CallState.Ended, execute: false });
    expect(t(CallState.Idle, "TALK")).toEqual({ state: CallState.Idle, execute: false });
  });
  it("FAILED → IDLE and ENDED → IDLE on RESET", () => {
    expect(t(CallState.Failed, "RESET")).toEqual({ state: CallState.Idle, execute: false });
    expect(t(CallState.Ended, "RESET")).toEqual({ state: CallState.Idle, execute: false });
  });
});

describe("isCallInProgress", () => {
  it("true only for DIALING/RINGING/ACTIVE/HELD", () => {
    expect(isCallInProgress(CallState.Dialing)).toBe(true);
    expect(isCallInProgress(CallState.Ringing)).toBe(true);
    expect(isCallInProgress(CallState.Active)).toBe(true);
    expect(isCallInProgress(CallState.Held)).toBe(true);
    expect(isCallInProgress(CallState.Idle)).toBe(false);
    expect(isCallInProgress(CallState.Failed)).toBe(false);
    expect(isCallInProgress(CallState.Ended)).toBe(false);
  });
});
