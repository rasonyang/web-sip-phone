import { describe, expect, it } from "vitest";
import {
  EXTENSION_SOURCE,
  PAGE_SOURCE,
  PROTOCOL_VERSION,
  parsePageMessage,
  parseProvisionRequest,
  toPageState,
  type PageState
} from "../../src/shared/page-protocol.js";
import {
  EMPTY_DETAILS,
  IDLE_LINK,
  RuntimeState,
  type DisplayState,
  type ErrorCode,
  type LinkStatus
} from "../../src/shared/state.js";

const A1 = "0123456789abcdef0123456789abcdef";

/** A well-formed provision message on the wire: the credential fields ride flat. */
function provision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: PAGE_SOURCE,
    protocolVersion: PROTOCOL_VERSION,
    type: "provision",
    nonce: "n-1",
    sipDomain: "voice.example.com",
    wssUrl: "wss://voice.example.com:7443",
    account: "1001",
    a1Hash: A1,
    expiresAt: 1_770_000_000_000,
    ...overrides
  };
}

function state(link: Partial<LinkStatus>, error: ErrorCode | null, details = EMPTY_DETAILS): DisplayState {
  return {
    runtime: RuntimeState.Ready,
    error,
    reconnecting: false,
    busy: false,
    link: { ...IDLE_LINK, ...link },
    details
  };
}

describe("parsePageMessage", () => {
  it("accepts a hello", () => {
    expect(
      parsePageMessage({ source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "hello", nonce: "abc" })
    ).toEqual({ type: "hello", nonce: "abc" });
  });

  it("accepts a flat provision and nests the credential", () => {
    expect(parsePageMessage(provision())).toEqual({
      type: "provision",
      nonce: "n-1",
      credential: {
        sipDomain: "voice.example.com",
        wssUrl: "wss://voice.example.com:7443",
        account: "1001",
        a1Hash: A1,
        expiresAt: 1_770_000_000_000
      }
    });
  });

  it("accepts a ws:// transport as well as wss://", () => {
    const parsed = parsePageMessage(provision({ wssUrl: "ws://10.0.0.5:5066" }));
    expect(parsed).not.toBeNull();
  });

  it("accepts a deprovision", () => {
    expect(
      parsePageMessage({ source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "deprovision" })
    ).toEqual({ type: "deprovision" });
  });

  it.each([
    ["wrong source", provision({ source: "evil" })],
    ["extension source echoed back", provision({ source: EXTENSION_SOURCE })],
    ["protocol version 2", provision({ protocolVersion: 2 })],
    ["missing nonce", provision({ nonce: undefined })],
    ["empty nonce", provision({ nonce: "" })],
    ["non-string nonce", provision({ nonce: 7 })],
    ["uppercase a1Hash", provision({ a1Hash: A1.toUpperCase() })],
    ["31-char a1Hash", provision({ a1Hash: A1.slice(1) })],
    ["non-hex a1Hash", provision({ a1Hash: "z".repeat(32) })],
    ["missing a1Hash", provision({ a1Hash: undefined })],
    ["https wssUrl", provision({ wssUrl: "https://voice.example.com" })],
    ["unparseable wssUrl", provision({ wssUrl: "not a url" })],
    ["empty sipDomain", provision({ sipDomain: "" })],
    ["empty account", provision({ account: "" })],
    ["account with a space", provision({ account: "20 01" })],
    ["account carrying a host part", provision({ account: "2001@x" })],
    ["account with a scheme", provision({ account: "sip:2001" })],
    ["sipDomain with a space", provision({ sipDomain: "voice example.com" })],
    ["sipDomain as a SIP URI", provision({ sipDomain: "sip:voice.example.com" })],
    ["sipDomain with a port", provision({ sipDomain: "voice.example.com:5060" })],
    ["sipDomain with a path", provision({ sipDomain: "voice.example.com/ws" })],
    ["sipDomain with an underscore", provision({ sipDomain: "voice_example.com" })],
    ["non-date string expiresAt", provision({ expiresAt: "soon" })],
    ["empty string expiresAt", provision({ expiresAt: "" })],
    ["negative expiresAt", provision({ expiresAt: -1 })],
    ["zero expiresAt", provision({ expiresAt: 0 })],
    ["infinite expiresAt", provision({ expiresAt: Number.POSITIVE_INFINITY })],
    ["hello without a nonce", { source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "hello" }],
    ["unknown type", { source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "shutdown", nonce: "n" }],
    ["an array", [provision()]],
    ["null", null],
    ["a string", JSON.stringify(provision())],
    ["a number", 42],
    ["undefined", undefined]
  ])("rejects %s", (_label, input) => {
    expect(parsePageMessage(input)).toBeNull();
  });

  it("accepts the punctuation a SIP user part may legally carry", () => {
    for (const account of ["1001", "agent.2001", "a-b_c~d", "x+1", "%41"]) {
      expect(parsePageMessage(provision({ account }))).not.toBeNull();
    }
  });

  it("lowercases the realm so one credential cannot look like two", () => {
    const parsed = parsePageMessage(provision({ sipDomain: "Voice.Example.COM" }));
    expect((parsed as { credential: { sipDomain: string } }).credential.sipDomain).toBe("voice.example.com");
  });

  it("carries nothing but the five credential fields across", () => {
    // JSON.parse (unlike an object literal) gives a real own "__proto__" key to smuggle in.
    const hostile = JSON.parse(
      `{"source":"${PAGE_SOURCE}","protocolVersion":1,"type":"provision","nonce":"n-1",` +
        `"sipDomain":"voice.example.com","wssUrl":"wss://voice.example.com:7443",` +
        `"account":"1001","a1Hash":"${A1}","expiresAt":1770000000000,` +
        `"password":"hunter2","__proto__":{"polluted":true},"credential":{"a1Hash":"ffff"}}`
    ) as unknown;
    const parsed = parsePageMessage(hostile);
    expect(parsed?.type).toBe("provision");
    const credential = (parsed as unknown as { credential: Record<string, unknown> }).credential;
    expect(Object.keys(credential)).toEqual(["sipDomain", "wssUrl", "account", "a1Hash", "expiresAt"]);
    for (const key of ["password", "__proto__", "credential", "source", "type", "nonce", "protocolVersion"]) {
      expect(Object.prototype.hasOwnProperty.call(credential, key)).toBe(false);
    }
    expect(JSON.stringify(credential)).not.toContain("hunter2");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("parseProvisionRequest", () => {
  const credential = {
    sipDomain: "voice.example.com",
    wssUrl: "wss://voice.example.com:7443",
    account: "1001",
    a1Hash: A1,
    expiresAt: 1_770_000_000_000
  };

  it("accepts a already-nested credential, envelope-free", () => {
    expect(parseProvisionRequest(credential)).toEqual(credential);
  });

  it.each([
    ["a bad account", { ...credential, account: "20 01" }],
    ["a bad realm", { ...credential, sipDomain: "bad host" }],
    ["a bad a1Hash", { ...credential, a1Hash: "nope" }],
    ["a missing field", { ...credential, wssUrl: undefined }],
    ["a non-object", "credential"]
  ])("rejects %s", (_label, input) => {
    expect(parseProvisionRequest(input)).toBeNull();
  });
});

describe("toPageState", () => {
  it.each<[LinkStatus["registration"], ErrorCode | null, PageState["registration"]]>([
    ["up", null, "REGISTERED"],
    ["up", "REGISTRATION_FAILED", "REGISTERED"],
    ["up", "CONNECTION_LOST", "REGISTERED"],
    ["connecting", null, "REGISTERING"],
    ["connecting", "REGISTRATION_FAILED", "REGISTERING"],
    ["down", null, "UNREGISTERED"],
    ["down", "CONNECTION_LOST", "UNREGISTERED"],
    ["down", "MICROPHONE_BLOCKED", "UNREGISTERED"],
    ["down", "REGISTRATION_FAILED", "FAILED"]
  ])("maps registration %s with error %s", (registration, error, expected) => {
    expect(toPageState(state({ registration }, error)).registration).toBe(expected);
  });

  it.each<[LinkStatus["microphone"], PageState["microphone"]]>([
    ["ok", "GRANTED"],
    ["blocked", "DENIED"],
    ["unknown", "UNKNOWN"]
  ])("maps microphone %s", (microphone, expected) => {
    expect(toPageState(state({ microphone }, null)).microphone).toBe(expected);
  });

  it.each<[ErrorCode | null, PageState["error"]]>([
    ["MICROPHONE_BLOCKED", "MIC_UNAVAILABLE"],
    ["CONNECTION_LOST", "WSS_LOST"],
    ["REGISTRATION_FAILED", "REGISTRATION_FAILED"],
    ["MEDIA_FAILED", "MEDIA_FAILED"],
    [null, null]
  ])("maps error %s", (error, expected) => {
    expect(toPageState(state({}, error)).error).toBe(expected);
  });

  it("emits exactly the page-facing keys", () => {
    const out = toPageState(
      state({ registration: "up" }, null, {
        ...EMPTY_DETAILS,
        account: "1001",
        domain: "voice.example.com",
        credentialSource: "PROVISIONED"
      })
    );
    expect(Object.keys(out)).toEqual([
      "source",
      "protocolVersion",
      "type",
      "registration",
      "account",
      "sipDomain",
      "credentialSource",
      "provisionStatus",
      "microphone",
      "error"
    ]);
    expect(out.source).toBe(EXTENSION_SOURCE);
    expect(out.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(out.account).toBe("1001");
    expect(out.sipDomain).toBe("voice.example.com");
    expect(out.credentialSource).toBe("PROVISIONED");
  });

  it("never carries a secret out, even when details are polluted", () => {
    const polluted = { ...EMPTY_DETAILS, account: "1001" } as Record<string, unknown>;
    polluted.a1Hash = "deadbeef";
    polluted.password = "hunter2";
    const json = JSON.stringify(
      toPageState(state({ registration: "up" }, null, polluted as unknown as DisplayState["details"]))
    );
    expect(json).not.toContain("a1Hash");
    expect(json).not.toContain("deadbeef");
    expect(json).not.toContain("hunter2");
  });
});

describe("parseProvisionRequest expiresAt wire forms", () => {
  it("accepts an RFC 3339 date-time string and normalises it to epoch ms", () => {
    const parsed = parseProvisionRequest({ ...provision({ expiresAt: "2026-09-12T20:07:27Z" }) });
    expect(parsed?.expiresAt).toBe(Date.parse("2026-09-12T20:07:27Z"));
    expect(typeof parsed?.expiresAt).toBe("number");
  });
  it("accepts an RFC 3339 string with a numeric UTC offset", () => {
    const parsed = parseProvisionRequest({ ...provision({ expiresAt: "2026-09-13T04:07:27+08:00" }) });
    expect(parsed?.expiresAt).toBe(Date.parse("2026-09-12T20:07:27Z"));
  });
  it("still accepts a finite epoch-ms number", () => {
    expect(parseProvisionRequest({ ...provision({ expiresAt: 1_770_000_000_000 }) })?.expiresAt).toBe(1_770_000_000_000);
  });
  it("normalises the string form on the full page message too", () => {
    const msg = parsePageMessage(provision({ expiresAt: "2026-09-12T20:07:27Z" }));
    expect(msg?.type).toBe("provision");
    expect(msg && msg.type === "provision" ? msg.credential.expiresAt : null).toBe(Date.parse("2026-09-12T20:07:27Z"));
  });
});

describe("toPageState provisionStatus", () => {
  it.each(["NONE", "ACTIVE", "OVERRIDDEN"] as const)("passes %s through unchanged", (status) => {
    const out = toPageState({
      runtime: RuntimeState.Ready,
      error: null,
      reconnecting: false,
      busy: false,
      link: IDLE_LINK,
      details: { ...EMPTY_DETAILS, provisionStatus: status }
    });
    expect(out.provisionStatus).toBe(status);
  });
});
