import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockTransport } from "./mock-transport.js";
import { FakeSDH } from "./fake-sdh.js";
import { ackFor, inDialogRequest, notify, replyTo, serverInvite } from "./sip-fixtures.js";
import { readyHarness } from "./harness.js";

vi.mock("../../src/offscreen/media.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeMicPermission: () => Promise.resolve("granted" as const)
}));

beforeEach(() => {
  MockTransport.instances = [];
  FakeSDH.created = [];
});

describe("FreeSWITCH-controlled outbound (Agent First)", () => {
  it("4+7. INVITE with answer-after=0 auto-answers; talk while DIALING → callInProgress stays, hold/resume re-INVITEs", async () => {
    const h = await readyHarness();
    const { raw, dialog } = serverInvite({
      user: "1001",
      domain: "voice.example.com",
      callInfo: "<sip:voice.example.com>;answer-after=0"
    });
    const sentBefore = h.transport().sent.length;
    h.transport().deliver(raw);

    // Auto-answer: client sends 200 OK with SDP without any talk event.
    const ok = await vi.waitFor(async () => {
      const m = h.transport().sent.slice(sentBefore).find((x) => x.startsWith("SIP/2.0 200"));
      expect(m).toBeDefined();
      return m!;
    });
    h.transport().deliver(ackFor(ok, dialog));
    await vi.waitFor(() => expect(h.last().callInProgress).toBe(true));

    // 8. Event: hold while ACTIVE → client re-INVITEs with sendonly.
    h.transport().deliver(notify(dialog, "talk")); // DIALING → ACTIVE first
    const beforeHold = h.transport().sent.length;
    h.transport().deliver(notify(dialog, "hold"));
    const reInvite = await h.sentRequest("INVITE", beforeHold);
    expect(reInvite).toContain("a=sendonly");
    const beforeHoldReply = h.transport().sent.length;
    h.transport().deliver(replyTo(reInvite, 200, "OK", { toTag: dialog.serverTag, body: reInvite.split("\r\n\r\n")[1] }));
    // sip.js only clears its "pendingReinvite" latch once the client's ACK for the hold
    // re-INVITE has actually gone out; wait for it before sending the next event, or the
    // resume re-INVITE below races the ACK and is rejected with RequestPendingError.
    await h.sentRequest("ACK", beforeHoldReply);

    // 9. Event: talk while HELD → re-INVITE with sendrecv.
    const beforeResume = h.transport().sent.length;
    h.transport().deliver(notify(dialog, "talk"));
    const resumeInvite = await h.sentRequest("INVITE", beforeResume);
    expect(resumeInvite).toContain("a=sendrecv");
  });

  it("11. BYE while ACTIVE ends the call and clears callInProgress", async () => {
    const h = await readyHarness();
    const { raw, dialog } = serverInvite({
      user: "1001",
      domain: "voice.example.com",
      callInfo: "<sip:voice.example.com>;answer-after=0"
    });
    const before = h.transport().sent.length;
    h.transport().deliver(raw);
    const ok = await vi.waitFor(async () => {
      const m = h.transport().sent.slice(before).find((x) => x.startsWith("SIP/2.0 200"));
      expect(m).toBeDefined();
      return m!;
    });
    h.transport().deliver(ackFor(ok, dialog));
    await vi.waitFor(() => expect(h.last().callInProgress).toBe(true));

    // Land the call in ACTIVE (not still DIALING) before the BYE, so this genuinely exercises
    // the ACTIVE→BYE→Ended transition rather than DIALING→BYE→Failed (both report
    // callInProgress===false, so that assertion alone can't tell the two apart).
    h.transport().deliver(notify(dialog, "talk"));

    const beforeBye = h.transport().sent.length;
    h.transport().deliver(inDialogRequest(dialog, "BYE"));
    await vi.waitFor(() => expect(h.last().callInProgress).toBe(false));
    const byeResponse = await vi.waitFor(async () => {
      const m = h.transport()
        .sent.slice(beforeBye)
        .find((x) => x.startsWith("SIP/2.0 200") && /^CSeq:.*BYE/im.test(x));
      expect(m).toBeDefined();
      return m!;
    });
    expect(byeResponse).toBeDefined();
  });

  it("12. BYE while HELD ends the call and clears callInProgress", async () => {
    const h = await readyHarness();
    const { raw, dialog } = serverInvite({
      user: "1001",
      domain: "voice.example.com",
      callInfo: "<sip:voice.example.com>;answer-after=0"
    });
    const before = h.transport().sent.length;
    h.transport().deliver(raw);
    const ok = await vi.waitFor(async () => {
      const m = h.transport().sent.slice(before).find((x) => x.startsWith("SIP/2.0 200"));
      expect(m).toBeDefined();
      return m!;
    });
    h.transport().deliver(ackFor(ok, dialog));
    await vi.waitFor(() => expect(h.last().callInProgress).toBe(true));

    // ACTIVE via talk, then HELD via hold — assert the hold re-INVITE is actually observed
    // (sendonly) so the state at BYE time is unambiguously HELD, not DIALING/ACTIVE.
    h.transport().deliver(notify(dialog, "talk"));
    const beforeHold = h.transport().sent.length;
    h.transport().deliver(notify(dialog, "hold"));
    const reInvite = await h.sentRequest("INVITE", beforeHold);
    expect(reInvite).toContain("a=sendonly");
    const beforeHoldReply = h.transport().sent.length;
    h.transport().deliver(replyTo(reInvite, 200, "OK", { toTag: dialog.serverTag, body: reInvite.split("\r\n\r\n")[1] }));
    // Same pendingReinvite latch as the hold/resume test: wait for the client's ACK before
    // moving on, so the BYE below isn't racing an in-flight re-INVITE transaction.
    await h.sentRequest("ACK", beforeHoldReply);

    const beforeBye = h.transport().sent.length;
    h.transport().deliver(inDialogRequest(dialog, "BYE"));
    await vi.waitFor(() => expect(h.last().callInProgress).toBe(false));
    const byeResponse = await vi.waitFor(async () => {
      const m = h.transport()
        .sent.slice(beforeBye)
        .find((x) => x.startsWith("SIP/2.0 200") && /^CSeq:.*BYE/im.test(x));
      expect(m).toBeDefined();
      return m!;
    });
    expect(byeResponse).toBeDefined();
  });
});
