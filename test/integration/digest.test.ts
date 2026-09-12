import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../src/shared/messages.js";
import { MockTransport } from "./mock-transport.js";
import { header, replyTo } from "./sip-fixtures.js";
import { makeHarness } from "./harness.js";
import { md5 } from "./md5.js";

vi.mock("../../src/offscreen/media.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeMicPermission: () => Promise.resolve("granted" as const),
  acquireMicOnce: () => Promise.resolve(true),
  watchMicPermission: () => () => {}
}));

const REALM = "voice.example.com";
const ACCOUNT = "2001";
const PASSWORD = "secret";
/** Exactly what a host page computes and pushes in: md5(account:realm:password). */
const A1_HASH = md5(`${ACCOUNT}:${REALM}:${PASSWORD}`);

const PROVISIONED: RuntimeConfig = {
  sipUri: `sip:${ACCOUNT}@${REALM}`,
  serverUrl: "wss://voice.example.com:7443/ws",
  username: ACCOUNT,
  a1Hash: A1_HASH,
  credentialSource: "provisioned",
  iceServers: []
};

/** Pull one quoted-or-bare parameter out of an Authorization header. */
function authParam(auth: string, name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^,\\s]+))`, "i").exec(auth);
  return match?.[1] ?? match?.[2] ?? "";
}

beforeEach(() => {
  MockTransport.instances = [];
  MockTransport.failConnects = 0;
});

describe("digest authentication from a provisioned a1Hash", () => {
  it("answers a 401 with a response computed from the hash, never from a password", async () => {
    const h = makeHarness();
    const startP = h.runtime.start(PROVISIONED);
    const first = await h.sentRequest("REGISTER");
    expect(first).not.toMatch(/Authorization:/i);

    const sentBefore = h.transport().sent.length;
    h.transport().deliver(
      replyTo(first, 401, "Unauthorized", {
        extraHeaders: [`WWW-Authenticate: Digest realm="${REALM}", nonce="abc123", algorithm=MD5, qop="auth"`]
      })
    );

    const second = await h.sentRequest("REGISTER", sentBefore);
    const auth = header(second, "Authorization");
    expect(auth).toMatch(/^Digest/i);
    expect(authParam(auth, "username")).toBe(ACCOUNT);
    expect(authParam(auth, "realm")).toBe(REALM);
    expect(authParam(auth, "nonce")).toBe("abc123");

    // RFC 2617 with qop=auth, recomputed here from the ha1 alone. Matching proves the UA
    // authenticated from the provisioned hash: no plaintext password exists in this test.
    const uri = authParam(auth, "uri");
    const nc = authParam(auth, "nc");
    const cnonce = authParam(auth, "cnonce");
    const qop = authParam(auth, "qop");
    expect(qop).toBe("auth");
    const ha2 = md5(`REGISTER:${uri}`);
    expect(authParam(auth, "response")).toBe(md5(`${A1_HASH}:abc123:${nc}:${cnonce}:${qop}:${ha2}`));

    h.transport().deliver(replyTo(second, 200, "OK", { extraHeaders: [`Contact: ${header(second, "Contact")};expires=600`] }));
    await startP;
    await vi.waitFor(() => expect(h.last().phase).toBe("ready"));
  });
});
