import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockTransport } from "./mock-transport.js";
import { FakeSDH } from "./fake-sdh.js";
import { ackFor, cancel, learnClientTag, notify, serverInvite } from "./sip-fixtures.js";
import { readyHarness } from "./harness.js";

vi.mock("../../src/offscreen/media.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeMicPermission: () => Promise.resolve("granted" as const)
}));

beforeEach(() => {
  MockTransport.instances = [];
  FakeSDH.created = [];
  FakeSDH.gate = null;
});

describe("normal inbound calls", () => {
  it("5+6. INVITE without Answer-After rings (no auto-answer); talk answers it", async () => {
    const h = await readyHarness();
    const { raw, dialog } = serverInvite({ user: "1001", domain: "voice.example.com" });
    const before = h.transport().sent.length;
    h.transport().deliver(raw);
    await vi.waitFor(() => expect(h.last().callInProgress).toBe(true)); // RINGING counts as in progress
    expect(h.ringing()).toBe(true); // design.md §9.4: the ringtone loops for as long as it rings

    // Client auto-sends 180 Ringing (autoSendAnInitialProvisionalResponse); this also sets up
    // the early-dialog delegate so the NOTIFY below can be routed. Learn the client's dialog
    // tag from it so the NOTIFY matches the (still early) dialog.
    const ringing = await h.sentRequest("SIP/2.0 180", before);
    learnClientTag(ringing, dialog);

    // No 200 OK sent spontaneously. The 180 Ringing above proves the stack has fully
    // processed the INVITE (it's sent only after INVITE handling completes), so checking
    // for the absence of a 200-with-SDP at this point is a deterministic ordering fact —
    // not a timing window — and needs no real-clock wait.
    expect(
      h.transport().sent.slice(before).some((m) => m.startsWith("SIP/2.0 200") && m.includes("application/sdp"))
    ).toBe(false);

    // Remote answer via Event: talk (early dialog NOTIFY).
    h.transport().deliver(notify(dialog, "talk"));
    const ok = await vi.waitFor(async () => {
      const m = h.transport().sent.slice(before).find((x) => x.startsWith("SIP/2.0 200") && x.includes("application/sdp"));
      expect(m).toBeDefined();
      return m!;
    });
    h.transport().deliver(ackFor(ok, dialog));
    await vi.waitFor(() => expect(h.last().callInProgress).toBe(true));
    expect(h.ringing()).toBe(false); // answered: silenced before the caller's audio arrives
  });

  it("10. CANCEL while RINGING ends the call quietly", async () => {
    const h = await readyHarness();
    const { raw, dialog } = serverInvite({ user: "1001", domain: "voice.example.com" });
    h.transport().deliver(raw);
    await vi.waitFor(() => expect(h.last().callInProgress).toBe(true));
    expect(h.ringing()).toBe(true);
    h.transport().deliver(cancel(dialog));
    await vi.waitFor(() => expect(h.last().callInProgress).toBe(false));
    expect(h.ringing()).toBe(false);
    expect(h.last().errors).toEqual([]);
  });

  it("second INVITE during a session is answered 486 and does not disturb the first", async () => {
    const h = await readyHarness();
    const first = serverInvite({ user: "1001", domain: "voice.example.com" });
    h.transport().deliver(first.raw);
    await vi.waitFor(() => expect(h.last().callInProgress).toBe(true));
    const before = h.transport().sent.length;
    const second = serverInvite({ user: "1001", domain: "voice.example.com" });
    h.transport().deliver(second.raw);
    await vi.waitFor(() => {
      expect(h.transport().sent.slice(before).some((m) => m.startsWith("SIP/2.0 486"))).toBe(true);
    });
    expect(h.last().callInProgress).toBe(true);
  });
});

// Issue #37, against the real library: a CANCEL landing while the talk-triggered accept() is
// still gathering makes SIP.js resolve (not reject) accept(), which used to leave the manager
// ACTIVE with an empty slot and answer every later INVITE 486.
describe("CANCEL while the talk-triggered answer is in flight (#37)", () => {
  it("does not wedge the phone: the next INVITE rings and is never answered 486", async () => {
    const h = await readyHarness();
    let openGate!: () => void;
    FakeSDH.gate = new Promise<void>((r) => (openGate = r));

    const first = serverInvite({ user: "1001", domain: "voice.example.com" });
    const before = h.transport().sent.length;
    h.transport().deliver(first.raw);
    await vi.waitFor(() => expect(h.last().callInProgress).toBe(true));
    learnClientTag(await h.sentRequest("SIP/2.0 180", before), first.dialog);

    h.transport().deliver(notify(first.dialog, "talk")); // accept() now blocked on the gate
    await vi.waitFor(() => expect(h.ringing()).toBe(false)); // the answer path has started
    h.transport().deliver(cancel(first.dialog));
    await vi.waitFor(() => expect(h.last().callInProgress).toBe(false));
    openGate(); // accept() settles after the CANCEL won
    await new Promise((r) => setTimeout(r, 20)); // real timers: let the stale accept() continuation run

    const mark = h.transport().sent.length;
    const second = serverInvite({ user: "1001", domain: "voice.example.com" });
    h.transport().deliver(second.raw);
    // handleInvite rings or rejects synchronously, so once it rings any 486 would already be sent.
    await vi.waitFor(() => expect(h.ringing()).toBe(true));
    expect(h.transport().sent.slice(mark).some((m) => m.startsWith("SIP/2.0 180"))).toBe(true);
    expect(h.transport().sent.slice(mark).some((m) => m.startsWith("SIP/2.0 486"))).toBe(false);
    expect(h.last().callInProgress).toBe(true);
  });
});
