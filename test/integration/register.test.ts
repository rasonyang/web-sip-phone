import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockTransport } from "./mock-transport.js";
import { header, replyTo } from "./sip-fixtures.js";
import { CONFIG, makeHarness } from "./harness.js";

vi.mock("../../src/offscreen/media.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeMicPermission: () => Promise.resolve("granted" as const)
}));

beforeEach(() => {
  MockTransport.instances = [];
  MockTransport.failConnects = 0;
});

describe("registration over the real stack", () => {
  it("1. REGISTER success → ready", async () => {
    const h = makeHarness();
    const startP = h.runtime.start(CONFIG);
    const reg = await h.sentRequest("REGISTER");
    expect(header(reg, "To")).toContain("sip:1001@voice.example.com");
    h.transport().deliver(replyTo(reg, 200, "OK", { extraHeaders: [`Contact: ${header(reg, "Contact")};expires=600`] }));
    await startP;
    await vi.waitFor(() => expect(h.last().phase).toBe("ready"));
  });

  it("2. REGISTER failure → REGISTRATION_FAILED", async () => {
    const h = makeHarness();
    const startP = h.runtime.start(CONFIG);
    const reg = await h.sentRequest("REGISTER");
    h.transport().deliver(replyTo(reg, 403, "Forbidden"));
    await startP;
    await vi.waitFor(() => expect(h.last().errors).toContain("REGISTRATION_FAILED"));
  });

  it("3. WSS disconnect → reconnect → re-register", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const startP = h.runtime.start(CONFIG);
    const reg = await h.sentRequest("REGISTER");
    h.transport().deliver(replyTo(reg, 200, "OK", { extraHeaders: [`Contact: ${header(reg, "Contact")};expires=600`] }));
    await startP;
    const sentBefore = h.transport().sent.length;
    h.transport().fail();
    await vi.waitFor(() => expect(h.last().reconnecting).toBe(true));
    await vi.advanceTimersByTimeAsync(1100);
    const reg2 = await h.sentRequest("REGISTER", sentBefore);
    h.transport().deliver(replyTo(reg2, 200, "OK", { extraHeaders: [`Contact: ${header(reg2, "Contact")};expires=600`] }));
    await vi.waitFor(() => {
      expect(h.last().phase).toBe("ready");
      expect(h.last().reconnecting).toBe(false);
    });
    vi.useRealTimers();
  });

  it("unregister on stop carries Expires: 0", async () => {
    const h = makeHarness();
    const startP = h.runtime.start(CONFIG);
    const reg = await h.sentRequest("REGISTER");
    h.transport().deliver(replyTo(reg, 200, "OK", { extraHeaders: [`Contact: ${header(reg, "Contact")};expires=600`] }));
    await startP;
    const sentBefore = h.transport().sent.length;
    const stopP = h.runtime.stop();
    const unreg = await h.sentRequest("REGISTER", sentBefore);
    expect(/expires=0|Expires:\s*0/i.test(unreg)).toBe(true);
    h.transport().deliver(replyTo(unreg, 200, "OK"));
    await stopP;
    expect(h.last().phase).toBe("stopped");
  });
});
