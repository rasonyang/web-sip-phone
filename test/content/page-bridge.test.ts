// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PageBridge } from "../../src/content/page-bridge.js";
import type { Msg, TabState } from "../../src/shared/messages.js";
import { EXTENSION_SOURCE, PAGE_SOURCE, PROTOCOL_VERSION } from "../../src/shared/page-protocol.js";
import { EMPTY_DETAILS, IDLE_LINK, RuntimeState, type DisplayState } from "../../src/shared/state.js";

const VERSION = "1.0.2";
const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const A1 = "0123456789abcdef0123456789abcdef";

function displayState(registration: DisplayState["link"]["registration"]): DisplayState {
  return {
    runtime: RuntimeState.Ready,
    error: null,
    reconnecting: false,
    busy: false,
    link: { ...IDLE_LINK, registration },
    details: { ...EMPTY_DETAILS, account: "1001", domain: "voice.example.com", credentialSource: "PROVISIONED" }
  };
}

function provisionMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** Cycle- and Window-safe, so a bridge holding the page window can still be serialised. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (v instanceof Window) {
          return "[Window]";
        }
        if (seen.has(v)) {
          return "[Circular]";
        }
        seen.add(v);
      }
      return v;
    }) ?? ""
  );
}

/** Every string reachable through the object's own properties, skipping the page window. */
function reachableStrings(value: unknown, seen = new WeakSet<object>(), depth = 0): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value !== "object" || value === null || depth > 8) {
    return [];
  }
  if (value instanceof Window || seen.has(value)) {
    return [];
  }
  seen.add(value);
  const out: string[] = [];
  for (const key of Object.getOwnPropertyNames(value)) {
    out.push(key);
    let child: unknown;
    try {
      child = (value as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    out.push(...reachableStrings(child, seen, depth + 1));
  }
  return out;
}

let sent: Msg[];
let requested: Msg[];
let requestResult: TabState | null | undefined;
let posts: Record<string, unknown>[];
let bridge: PageBridge;
let collect: (e: MessageEvent) => void;

const ORIGIN = window.location.origin;
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A page → extension message with a controlled origin and source. */
function fromPage(data: unknown, origin = ORIGIN, source: unknown = window): void {
  window.dispatchEvent(
    new MessageEvent("message", { data, origin, source: source as MessageEventSource | null })
  );
}

beforeEach(() => {
  sent = [];
  requested = [];
  requestResult = { state: displayState("up"), pos: null };
  posts = [];
  delete document.documentElement.dataset.webSipPhone;
  // Bridge output and test-dispatched page messages land on the same listener; only messages
  // stamped with the extension source are output.
  collect = (e: MessageEvent) => {
    const data = e.data as Record<string, unknown> | null;
    if (data && typeof data === "object" && data.source === EXTENSION_SOURCE) {
      posts.push(data);
    }
  };
  window.addEventListener("message", collect);
  bridge = new PageBridge({
    win: window,
    version: VERSION,
    extensionId: EXT_ID,
    send: (msg) => sent.push(msg),
    request: (msg) => {
      requested.push(msg);
      return Promise.resolve(requestResult);
    }
  });
});

afterEach(() => {
  bridge.detach();
  window.removeEventListener("message", collect);
});

describe("PageBridge presence", () => {
  it("marks the document synchronously on attach", () => {
    expect(document.documentElement.dataset.webSipPhone).toBeUndefined();
    bridge.attach();
    expect(document.documentElement.dataset.webSipPhone).toBe(VERSION);
  });
});

describe("PageBridge hello", () => {
  it("answers with a reply then state pulled from the worker", async () => {
    bridge.attach();
    fromPage({ source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "hello", nonce: "n-42" });
    await flush();

    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual({
      source: EXTENSION_SOURCE,
      protocolVersion: PROTOCOL_VERSION,
      type: "hello",
      nonce: "n-42",
      extensionVersion: VERSION,
      extensionId: EXT_ID
    });
    expect(posts[1]).toMatchObject({ source: EXTENSION_SOURCE, type: "state", registration: "REGISTERED" });
    expect(requested).toEqual([{ target: "background", type: "page/hello" }]);
    expect(sent).toEqual([]);
  });

  it("answers from the last published state at once, and still checks with the worker", async () => {
    bridge.attach();
    bridge.publish(displayState("connecting"));
    await flush();
    posts = [];
    requestResult = { state: displayState("connecting"), pos: null };

    fromPage({ source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "hello", nonce: "n-7" });
    await flush();

    // The worker's identical answer adds no second state.
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ type: "hello", nonce: "n-7" });
    expect(posts[1]).toMatchObject({ type: "state", registration: "REGISTERING" });
    expect(requested).toEqual([{ target: "background", type: "page/hello" }]);
  });

  it("follows a cached answer with the worker's fresher state when they differ", async () => {
    bridge.attach();
    bridge.publish(displayState("connecting"));
    await flush();
    posts = [];

    fromPage({ source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "hello", nonce: "n-8" });
    await flush();

    expect(posts.map((p) => p.registration ?? p.type)).toEqual(["hello", "REGISTERING", "REGISTERED"]);
  });

  it("stays silent when the worker has no state to give", async () => {
    requestResult = null;
    bridge.attach();
    fromPage({ source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "hello", nonce: "n-1" });
    await flush();

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ type: "hello" });
  });
});

describe("PageBridge worker decline", () => {
  const hello = (nonce: string): Record<string, unknown> => ({
    source: PAGE_SOURCE,
    protocolVersion: PROTOCOL_VERSION,
    type: "hello",
    nonce
  });

  it("drops the presence marker and stops listening when the worker declines", async () => {
    requestResult = undefined;
    bridge.attach();
    expect(document.documentElement.dataset.webSipPhone).toBe(VERSION);

    fromPage(hello("n-1"));
    await flush();

    // The marker must not outlive the site's Allow listing.
    expect(document.documentElement.dataset.webSipPhone).toBeUndefined();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ type: "hello", nonce: "n-1" });

    posts = [];
    fromPage(hello("n-2"));
    await flush();
    expect(posts).toEqual([]);
    expect(requested).toHaveLength(1);
  });

  it("keeps the marker and the listener when the worker does not answer at all", async () => {
    requestResult = null;
    bridge.attach();

    fromPage(hello("n-1"));
    await flush();

    // A sleeping service worker says nothing about whether the site is still allowed.
    expect(document.documentElement.dataset.webSipPhone).toBe(VERSION);
    expect(posts).toHaveLength(1);

    posts = [];
    fromPage(hello("n-2"));
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ type: "hello", nonce: "n-2" });
    expect(requested).toHaveLength(2);
  });

  it("a cached state does not shield a removed site from the decline", async () => {
    let declined = 0;
    bridge = new PageBridge({
      win: window,
      version: VERSION,
      extensionId: EXT_ID,
      send: (msg) => sent.push(msg),
      request: () => Promise.resolve(requestResult),
      onDeclined: () => declined++
    });
    bridge.attach();
    bridge.publish(displayState("up"));
    await flush();
    posts = [];

    requestResult = undefined; // the site was removed; the cache still says REGISTERED
    fromPage(hello("n-1"));
    await flush();
    expect(declined).toBe(1);

    posts = [];
    fromPage(hello("n-2"));
    await flush();
    expect(posts).toEqual([]);
  });

  it("keeps the cached answer, the marker and the listener when the worker is asleep", async () => {
    bridge.attach();
    bridge.publish(displayState("up"));
    await flush();
    posts = [];
    requestResult = null;

    fromPage(hello("n-1"));
    await flush();
    expect(posts.map((p) => p.type)).toEqual(["hello", "state"]);
    expect(document.documentElement.dataset.webSipPhone).toBe(VERSION);

    posts = [];
    fromPage(hello("n-2"));
    await flush();
    expect(posts.map((p) => p.type)).toEqual(["hello", "state"]);
  });
});

describe("PageBridge event filtering", () => {
  const hello = { source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "hello", nonce: "n-1" };

  it("drops a cross-origin hello without a reply", async () => {
    bridge.attach();
    fromPage(hello, "https://evil.example", window);
    await flush();
    expect(posts).toEqual([]);
    expect(sent).toEqual([]);
    expect(requested).toEqual([]);
  });

  it("drops a message from an iframe on the page origin", async () => {
    bridge.attach();
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    fromPage(hello, ORIGIN, iframe.contentWindow);
    await flush();
    expect(posts).toEqual([]);
    expect(sent).toEqual([]);
    iframe.remove();
  });

  it("drops a message with no source", async () => {
    bridge.attach();
    fromPage(hello, ORIGIN, null);
    await flush();
    expect(posts).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("drops a cross-origin provision", async () => {
    bridge.attach();
    fromPage(provisionMessage(), "https://evil.example", window);
    await flush();
    expect(sent).toEqual([]);
  });
});

describe("PageBridge provisioning", () => {
  it("relays a valid provision once", async () => {
    bridge.attach();
    fromPage(provisionMessage());
    await flush();

    expect(sent).toEqual([
      {
        target: "background",
        type: "page/provision",
        credential: {
          sipDomain: "voice.example.com",
          wssUrl: "wss://voice.example.com:7443",
          account: "1001",
          a1Hash: A1,
          expiresAt: 1_770_000_000_000
        }
      }
    ]);
    expect(posts).toEqual([]);
  });

  it("relays nothing for a malformed provision", async () => {
    bridge.attach();
    fromPage(provisionMessage({ a1Hash: "nope" }));
    await flush();
    expect(sent).toEqual([]);
  });

  it("relays a deprovision", async () => {
    bridge.attach();
    fromPage({ source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "deprovision" });
    await flush();
    expect(sent).toEqual([{ target: "background", type: "page/deprovision" }]);
  });

  it("retains no part of the credential", async () => {
    bridge.attach();
    fromPage(provisionMessage());
    await flush();
    expect(sent).toHaveLength(1);

    expect(safeStringify(bridge)).not.toContain(A1);
    const strings = reachableStrings(bridge);
    expect(strings).not.toContain(A1);
    expect(strings.some((s) => s.includes(A1))).toBe(false);
    expect(strings).not.toContain("wss://voice.example.com:7443");

    // A later hello must not be able to read the credential back out.
    fromPage({ source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "hello", nonce: "n-9" });
    await flush();
    expect(JSON.stringify(posts)).not.toContain(A1);
  });
});

describe("PageBridge publish", () => {
  it("posts the mapped state and suppresses unchanged republishes", async () => {
    bridge.attach();
    bridge.publish(displayState("down"));
    bridge.publish(displayState("down"));
    await flush();

    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      source: EXTENSION_SOURCE,
      protocolVersion: PROTOCOL_VERSION,
      type: "state",
      registration: "UNREGISTERED",
      account: "1001",
      sipDomain: "voice.example.com",
      credentialSource: "PROVISIONED",
      provisionStatus: "NONE",
      microphone: "UNKNOWN",
      error: null
    });

    bridge.publish(displayState("up"));
    await flush();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ registration: "REGISTERED" });

    const json = JSON.stringify(posts);
    expect(json).not.toContain("a1Hash");
    expect(json).not.toContain("password");
  });
});

describe("PageBridge detach", () => {
  it("stops handling page messages", async () => {
    bridge.attach();
    bridge.detach();
    fromPage({ source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "hello", nonce: "n-1" });
    fromPage(provisionMessage());
    await flush();
    expect(posts).toEqual([]);
    expect(sent).toEqual([]);
    expect(requested).toEqual([]);
  });

  it("posts nothing for a worker answer that lands after detach", async () => {
    let answer: (ts: TabState) => void = () => {};
    bridge = new PageBridge({
      win: window,
      version: VERSION,
      extensionId: EXT_ID,
      send: (msg) => sent.push(msg),
      request: () => new Promise((resolve) => (answer = resolve))
    });
    bridge.attach();
    fromPage({ source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "hello", nonce: "n-1" });
    await flush();
    posts.length = 0;
    bridge.detach();
    answer({ state: displayState("up"), pos: null });
    await flush();
    expect(posts).toEqual([]);
  });
});

describe("PageBridge liveness", () => {
  it("an orphaned bridge neither answers nor relays, and stops listening", async () => {
    let alive = true;
    bridge = new PageBridge({
      win: window,
      version: VERSION,
      extensionId: EXT_ID,
      send: (msg) => sent.push(msg),
      request: () => Promise.resolve(requestResult),
      alive: () => alive
    });
    bridge.attach();
    bridge.publish(displayState("up"));
    await flush();
    posts.length = 0;
    alive = false;
    fromPage({ source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "hello", nonce: "n-1" });
    fromPage(provisionMessage());
    await flush();
    expect(posts).toEqual([]);
    expect(sent).toEqual([]);
    alive = true;
    fromPage({ source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "hello", nonce: "n-2" });
    await flush();
    expect(posts).toEqual([]);
  });
});
