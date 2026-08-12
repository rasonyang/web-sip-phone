import { expect, vi } from "vitest";
import type { OffscreenStatus, RuntimeConfig } from "../../src/shared/messages.js";
import { SipRuntime, type UaDelegate, type UaFactory } from "../../src/offscreen/sip-runtime.js";
import { Registerer, UserAgent } from "sip.js";
import { MockTransport } from "./mock-transport.js";
import { fakeSdhFactory } from "./fake-sdh.js";
import { header, isRequest, replyTo } from "./sip-fixtures.js";

export const CONFIG: RuntimeConfig = {
  sipUri: "sip:1001@voice.example.com",
  wssUrl: "wss://voice.example.com/",
  username: "1001",
  password: "pw",
  iceServers: []
};

/** UaFactory using the real sip.js with mock transport + fake SDH. */
export function testUaFactory(): UaFactory {
  return {
    create(config: RuntimeConfig, delegate: UaDelegate) {
      const uri = UserAgent.makeURI(config.sipUri)!;
      const ua = new UserAgent({
        uri,
        transportConstructor: MockTransport as never,
        transportOptions: { server: config.wssUrl },
        authorizationUsername: config.username,
        authorizationPassword: config.password,
        sessionDescriptionHandlerFactory: fakeSdhFactory,
        logBuiltinEnabled: false,
        delegate: {
          onConnect: () => delegate.onConnect(),
          onDisconnect: (error?: Error) => delegate.onDisconnect(error),
          onInvite: (invitation) => delegate.onInvite(invitation)
        }
      });
      return { ua, registerer: new Registerer(ua) };
    }
  };
}

export function makeHarness() {
  const statuses: OffscreenStatus[] = [];
  const runtime = new SipRuntime({
    factory: testUaFactory(),
    audio: {} as HTMLAudioElement,
    onStatus: (s) => statuses.push(s)
  });
  return {
    runtime,
    statuses,
    last: () => statuses[statuses.length - 1],
    transport: () => MockTransport.latest(),
    /** Wait until the client has sent a request of the given method, then return it. */
    async sentRequest(method: string, minIndex = 0): Promise<string> {
      let found: string | undefined;
      await vi.waitFor(() => {
        found = MockTransport.latest().sent.slice(minIndex).find((m) => isRequest(m, method));
        expect(found).toBeDefined();
      });
      return found!;
    }
  };
}

/** Bring a harness up through REGISTER success into "ready", for outbound/inbound scenarios. */
export async function readyHarness() {
  const h = makeHarness();
  const startP = h.runtime.start(CONFIG);
  const reg = await h.sentRequest("REGISTER");
  h.transport().deliver(replyTo(reg, 200, "OK", { extraHeaders: [`Contact: ${header(reg, "Contact")};expires=600`] }));
  await startP;
  await vi.waitFor(() => expect(h.last().phase).toBe("ready"));
  return h;
}
