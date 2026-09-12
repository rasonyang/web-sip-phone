import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome, type FakeChrome } from "../fakes/chrome.js";
import type { DisplayState } from "../../src/shared/state.js";
import type { RuntimeConfig } from "../../src/shared/messages.js";
import { SipRuntime } from "../../src/offscreen/sip-runtime.js";
import { MockTransport } from "./mock-transport.js";
import { header, isRequest, replyTo } from "./sip-fixtures.js";
import { testUaFactory } from "./harness.js";

vi.mock("../../src/offscreen/media.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeMicPermission: () => Promise.resolve("granted" as const),
  acquireMicOnce: () => Promise.resolve(true),
  watchMicPermission: () => () => {}
}));

const SITE = "crm.example.com";
const TAB_URL = "https://crm.example.com/app";
const SENDER = { tab: { id: 1, url: TAB_URL }, frameId: 0 };
const ACCOUNT = { domain: "voice.example.com", username: "1001", password: "pw" };
const PROV = {
  sipDomain: "voice.example.com",
  wssUrl: "wss://voice.example.com:7443/ws",
  account: "2001",
  a1Hash: "0123456789abcdef0123456789abcdef",
  expiresAt: Date.now() + 3_600_000
};

let fake: FakeChrome;
let runtime: SipRuntime;
let pump: ReturnType<typeof setInterval>;

/**
 * Plays the registrar: answers every REGISTER the client sends with a 200 OK, including the
 * Expires-0 unregister a credential swap emits. Runs on an interval because both sides are
 * driven by the service worker's own promise chain, not by the test.
 */
function startRegistrar() {
  const answered = new Map<MockTransport, number>();
  pump = setInterval(() => {
    for (const t of MockTransport.instances) {
      const from = answered.get(t) ?? 0;
      const sent = t.sent.length;
      answered.set(t, sent);
      for (const msg of t.sent.slice(from)) {
        if (isRequest(msg, "REGISTER")) {
          t.deliver(replyTo(msg, 200, "OK", { extraHeaders: [`Contact: ${header(msg, "Contact")};expires=600`] }));
        }
      }
    }
  }, 1);
}

/**
 * Stand in for chrome's message plumbing between the worker and the offscreen document: the
 * worker's `runtime/start` and `runtime/stop` drive a real SipRuntime, and the runtime's status
 * reports come back as `offscreen/status` messages.
 *
 * Runtime operations are queued rather than awaited inline: `sendMessage` must resolve for the
 * worker's evaluate() to continue, while a start() does not settle until the REGISTER is
 * answered, so awaiting it here would deadlock. The queue still guarantees a stop/start pair
 * runs in the order the worker sent it.
 */
function bridgeToRuntime() {
  runtime = new SipRuntime({
    factory: testUaFactory(),
    audio: {} as HTMLAudioElement,
    ringtone: { start: () => {}, stop: () => {} },
    onStatus: (status) => {
      fake.runtime.onMessage.fire({ target: "background", type: "offscreen/status", status }, {}, () => {});
    }
  });
  let chain = Promise.resolve();
  const enqueue = (op: () => Promise<void>) => {
    chain = chain.then(op, op).catch(() => {});
  };
  const original = fake.runtime.sendMessage;
  fake.runtime.sendMessage = async (message: unknown) => {
    const msg = message as { target?: string; type?: string; config?: RuntimeConfig };
    if (msg.target === "offscreen" && msg.type === "runtime/start") {
      enqueue(() => runtime.start(msg.config!));
    } else if (msg.target === "offscreen" && msg.type === "runtime/stop") {
      enqueue(() => runtime.stop());
    }
    return original(message);
  };
}

function seedConfig(account: Record<string, unknown> | null) {
  fake._localData["websipphone.account"] = account;
  fake._localData["websipphone.allowSites"] = [SITE];
  fake._localData["websipphone.turn"] = null;
  fake._localData["websipphone.dotPosition"] = null;
}

async function boot(account: Record<string, unknown> | null) {
  seedConfig(account);
  bridgeToRuntime();
  const mod = await import("../../src/background/service-worker.js");
  await mod.initServiceWorker();
  fake._openTab(1, TAB_URL);
}

const fire = (msg: Record<string, unknown>) =>
  fake.runtime.onMessage.fire({ target: "background", ...msg }, SENDER, () => {});

/** The most recent state the worker pushed to the Allow Site tab. */
function lastState(): DisplayState {
  const updates = fake.sentTabMessages.filter((m) => (m.message as { type?: string }).type === "state/update");
  return (updates[updates.length - 1].message as { state: DisplayState }).state;
}

async function waitForState(check: (s: DisplayState) => void) {
  await vi.waitFor(() => {
    expect(fake.sentTabMessages.length).toBeGreaterThan(0);
    check(lastState());
  });
}

/** True once the client has sent an Expires-0 REGISTER — the unregister — on this transport. */
const unregistered = (t: MockTransport, from: number) =>
  t.sent.slice(from).some((m) => isRequest(m, "REGISTER") && /expires=0|Expires:\s*0/i.test(m));

const registersTo = (t: MockTransport, uri: string, from = 0) =>
  t.sent.slice(from).filter((m) => isRequest(m, "REGISTER") && header(m, "To").includes(uri));

beforeEach(() => {
  vi.resetModules();
  fake = installFakeChrome();
  MockTransport.instances = [];
  MockTransport.failConnects = 0;
  startRegistrar();
});

afterEach(() => {
  clearInterval(pump);
});

describe("worker ↔ runtime provisioning, end to end", () => {
  it("swaps a registered manual account for a provisioned one and back", async () => {
    await boot(ACCOUNT);
    await waitForState((s) => {
      expect(s.link.registration).toBe("up");
      expect(s.details.credentialSource).toBe("MANUAL");
    });
    expect(registersTo(MockTransport.latest(), "sip:1001@voice.example.com").length).toBeGreaterThan(0);

    // --- provision: the manual registration is torn down and replaced, not layered over.
    const manualTransport = MockTransport.latest();
    const sentBefore = manualTransport.sent.length;
    fire({ type: "page/provision", credential: PROV });

    await vi.waitFor(() => expect(unregistered(manualTransport, sentBefore)).toBe(true));
    await vi.waitFor(() => expect(MockTransport.latest()).not.toBe(manualTransport));
    await waitForState((s) => {
      expect(s.details.credentialSource).toBe("PROVISIONED");
      expect(s.link.registration).toBe("up");
    });
    expect(lastState().details.account).toBe("2001");
    expect(registersTo(MockTransport.latest(), "sip:2001@voice.example.com").length).toBeGreaterThan(0);

    // --- deprovision: the manual account takes over again.
    const provTransport = MockTransport.latest();
    const provSentBefore = provTransport.sent.length;
    fire({ type: "page/deprovision" });

    await vi.waitFor(() => expect(unregistered(provTransport, provSentBefore)).toBe(true));
    await waitForState((s) => {
      expect(s.details.credentialSource).toBe("MANUAL");
      expect(s.link.registration).toBe("up");
    });
    expect(registersTo(MockTransport.latest(), "sip:1001@voice.example.com").length).toBeGreaterThan(0);
  });

  it("with no manual account, deprovisioning leaves the extension unconfigured", async () => {
    await boot(null);
    // Nothing to register with until a page provides a credential.
    await new Promise((r) => setTimeout(r, 20));
    expect(MockTransport.instances.length).toBe(0);

    fire({ type: "page/provision", credential: PROV });
    await waitForState((s) => {
      expect(s.details.credentialSource).toBe("PROVISIONED");
      expect(s.link.registration).toBe("up");
    });

    const provTransport = MockTransport.latest();
    const sentBefore = provTransport.sent.length;
    fire({ type: "page/deprovision" });

    await vi.waitFor(() => expect(unregistered(provTransport, sentBefore)).toBe(true));
    await waitForState((s) => {
      expect(s.runtime).toBe("UNCONFIGURED");
      expect(s.details.credentialSource).toBe("NONE");
      expect(s.link.registration).toBe("down");
    });
    expect(fake._offscreenOpen).toBe(false);
  });
});
