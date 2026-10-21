// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome, type FakeChrome } from "../fakes/chrome.js";
import { HOST_ID, mountWebSipPhone, REPLACE_EVENT, type WebSipPhoneInstance } from "../../src/content/instance.js";
import { createRuntimeGuard, isContextInvalidatedError } from "../../src/content/runtime-guard.js";
import type { Msg, TabState } from "../../src/shared/messages.js";
import { EXTENSION_SOURCE, PAGE_SOURCE, PROTOCOL_VERSION } from "../../src/shared/page-protocol.js";
import { EMPTY_DETAILS, IDLE_LINK, RuntimeState, type DisplayState } from "../../src/shared/state.js";

const ORIGIN = window.location.origin;
const INVALIDATED = "Extension context invalidated.";

function displayState(overrides: Partial<DisplayState> = {}): DisplayState {
  return {
    runtime: RuntimeState.Ready,
    error: null,
    reconnecting: false,
    busy: false,
    link: { ...IDLE_LINK, registration: "up", microphone: "ok" },
    details: { ...EMPTY_DETAILS, account: "1001", domain: "voice.example.com", credentialSource: "PROVISIONED" },
    ...overrides
  };
}

let fake: FakeChrome;
/** What the worker answers ui/getState and page/hello with; `null` rejects as a sleeping worker would. */
let reply: unknown;
let posts: Record<string, unknown>[];
let mounted: WebSipPhoneInstance[];

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** Put this content script's context in the state an extension reload leaves it in. */
function invalidate(): void {
  (fake.runtime as { id: string | undefined }).id = undefined;
  fake.runtime.sendMessage = () => {
    throw new Error(INVALIDATED);
  };
}

function hello(nonce = "n-1"): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "hello", nonce },
      origin: ORIGIN,
      source: window
    })
  );
}

function deprovision(): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: PAGE_SOURCE, protocolVersion: PROTOCOL_VERSION, type: "deprovision" },
      origin: ORIGIN,
      source: window
    })
  );
}

function declare(content = "widget=page"): HTMLMetaElement {
  const meta = document.createElement("meta");
  meta.name = "web-sip-phone";
  meta.content = content;
  document.head.appendChild(meta);
  return meta;
}

function broadcast(state: DisplayState): void {
  fake.runtime.onMessage.fire({ target: "content", type: "state/update", state, pos: null }, {}, () => {});
}

const hostEl = (): HTMLElement => document.getElementById(HOST_ID)!;
const shown = (): boolean => hostEl().style.display !== "none";
const busy = (): DisplayState => displayState({ busy: true });

const hellos = () => posts.filter((p) => p.type === "hello");
const states = () => posts.filter((p) => p.type === "state");
const hosts = () => document.querySelectorAll(`#${HOST_ID}`);

function mount(): WebSipPhoneInstance {
  const instance = mountWebSipPhone();
  expect(instance).not.toBeNull();
  mounted.push(instance!);
  return instance!;
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = installFakeChrome();
  reply = { state: displayState(), pos: null };
  fake.runtime.sendMessage = async (message: unknown) => {
    fake.sentRuntimeMessages.push(message);
    const type = (message as Msg).type;
    if (type === "ui/getState" || type === "page/hello") {
      if (reply === null) {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      return reply;
    }
    return undefined;
  };
  posts = [];
  mounted = [];
  vi.spyOn(window, "postMessage").mockImplementation((msg: unknown) => {
    const data = msg as Record<string, unknown>;
    if (data?.source === EXTENSION_SOURCE) {
      posts.push(data);
    }
  });
  document.querySelectorAll(`#${HOST_ID}`).forEach((el) => el.remove());
  document.head.querySelectorAll('meta[name="web-sip-phone"]').forEach((el) => el.remove());
  delete document.documentElement.dataset.webSipPhone;
});

afterEach(() => {
  for (const m of mounted) {
    m.teardown();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runtime guard", () => {
  it("recognises the invalidation message however it arrives", () => {
    expect(isContextInvalidatedError(new Error(INVALIDATED))).toBe(true);
    expect(isContextInvalidatedError(INVALIDATED)).toBe(true);
    expect(isContextInvalidatedError(new Error("Receiving end does not exist."))).toBe(false);
  });

  it("fires once for a synchronous throw, and treats an ordinary rejection as a sleeping worker", async () => {
    const onInvalidated = vi.fn();
    const guard = createRuntimeGuard(onInvalidated);
    reply = null;
    await expect(guard.request({ target: "background", type: "ui/getState" })).resolves.toBeNull();
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(guard.alive()).toBe(true);

    fake.runtime.sendMessage = () => {
      throw new Error(INVALIDATED);
    };
    expect(() => guard.send({ target: "background", type: "ui/retry" })).not.toThrow();
    expect(onInvalidated).toHaveBeenCalledTimes(1);
    expect(guard.alive()).toBe(false);
    await expect(guard.request({ target: "background", type: "ui/getState" })).resolves.toBeNull();
    expect(guard.call(() => "reached", "fallback")).toBe("fallback");
    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  it("fires for an async rejection carrying the invalidation message", async () => {
    const onInvalidated = vi.fn();
    const guard = createRuntimeGuard(onInvalidated);
    fake.runtime.sendMessage = () => Promise.reject(new Error(INVALIDATED));
    await guard.request({ target: "background", type: "ui/getState" });
    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });
});

describe("content script instance", () => {
  it("mounts the widget and marker, answers hello, and publishes its first state unsolicited", async () => {
    mount();
    expect(hosts()).toHaveLength(1);
    expect(document.documentElement.dataset.webSipPhone).toBe("9.9.9");
    await flush();
    expect(states()).toHaveLength(1);
    expect(states()[0]).toMatchObject({ registration: "REGISTERED", microphone: "GRANTED" });

    hello();
    await flush();
    expect(hellos()).toEqual([expect.objectContaining({ nonce: "n-1", extensionVersion: "9.9.9", extensionId: "fake-id" })]);
    expect(states()).toHaveLength(2);
  });

  it("tears down completely once the context is invalidated, and an orphan does not answer hello", async () => {
    // Spies call through, so the listeners are really attached and removed.
    const addDoc = vi.spyOn(document, "addEventListener");
    const rmDoc = vi.spyOn(document, "removeEventListener");
    const addWin = vi.spyOn(window, "addEventListener");
    const rmWin = vi.spyOn(window, "removeEventListener");
    const pairs = (spy: { mock: { calls: unknown[][] } }): Array<[unknown, unknown]> =>
      spy.mock.calls.map((c) => [c[0], c[1]]);

    // The worker is asleep, so a retry of the initial fetch is pending when the context goes.
    reply = null;
    const instance = mount();
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    expect(fake.runtime.onMessage.listeners).toHaveLength(1);

    invalidate();
    window.dispatchEvent(new Event("focus"));

    expect(instance.disposed).toBe(true);
    expect(hosts()).toHaveLength(0);
    expect(document.documentElement.dataset.webSipPhone).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(fake.runtime.onMessage.listeners).toHaveLength(0);
    for (const [type, listener] of pairs(addDoc)) {
      expect(pairs(rmDoc), `document ${String(type)}`).toContainEqual([type, listener]);
    }
    for (const [type, listener] of pairs(addWin)) {
      expect(pairs(rmWin), `window ${String(type)}`).toContainEqual([type, listener]);
    }
    expect(pairs(addWin).map(([t]) => t)).toEqual(expect.arrayContaining(["message", "focus", "resize"]));
    expect(pairs(addDoc).map(([t]) => t)).toEqual(
      expect.arrayContaining(["visibilitychange", "pointerdown", "keydown", REPLACE_EVENT])
    );

    posts.length = 0;
    hello();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(posts).toEqual([]);
  });

  it("an orphan still holding cached state does not replay it to a hello", async () => {
    const instance = mount();
    await flush();
    posts.length = 0;
    // Nothing else has touched chrome.runtime since: the hello itself is the detection point.
    invalidate();
    hello();
    await flush();
    expect(posts).toEqual([]);
    expect(instance.disposed).toBe(true);
    expect(document.documentElement.dataset.webSipPhone).toBeUndefined();
  });

  it("tears down when the initial fetch is rejected as invalidated, leaving no retry behind", async () => {
    fake.runtime.sendMessage = () => Promise.reject(new Error(INVALIDATED));
    const instance = mount();
    await flush();
    expect(instance.disposed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(hosts()).toHaveLength(0);
  });

  it("a drag's position save from an orphan does not throw", async () => {
    const instance = mount();
    await flush();
    invalidate();
    const dot = document.getElementById(HOST_ID)!.shadowRoot!.querySelector("[data-role=dot]") as HTMLElement;
    dot.setPointerCapture = () => {};
    dot.dispatchEvent(new MouseEvent("pointerdown", { clientX: 10, clientY: 10 }));
    dot.dispatchEvent(new MouseEvent("pointermove", { clientX: 60, clientY: 60 }));
    expect(() => dot.dispatchEvent(new MouseEvent("pointerup", { clientX: 60, clientY: 60 }))).not.toThrow();
    expect(instance.disposed).toBe(true);
  });

  it("does not mount at all in a context that is already gone", () => {
    invalidate();
    expect(mountWebSipPhone()).toBeNull();
    expect(hosts()).toHaveLength(0);
    expect(document.documentElement.dataset.webSipPhone).toBeUndefined();
  });
});

describe("site removal", () => {
  function expectGone(instance: WebSipPhoneInstance): void {
    expect(instance.disposed).toBe(true);
    expect(hosts()).toHaveLength(0);
    expect(document.documentElement.dataset.webSipPhone).toBeUndefined();
    expect(fake.runtime.onMessage.listeners).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  }

  it("a hello the worker declines tears the whole instance down, cached state or not", async () => {
    const instance = mount();
    await flush();
    expect(states()).toHaveLength(1); // cached REGISTERED

    // The site is removed: the worker now declines, and this tab gets no more broadcasts.
    fake.runtime.sendMessage = async (message: unknown) => {
      fake.sentRuntimeMessages.push(message);
      return { declined: true };
    };
    posts.length = 0;
    hello();
    await flush();
    expect(fake.sentRuntimeMessages).toContainEqual({ target: "background", type: "page/hello" });
    expectGone(instance);

    posts.length = 0;
    hello("n-2");
    await flush();
    expect(posts).toEqual([]);
  });

  it.each([
    ["an undefined reply", async () => undefined],
    ["a null reply", async () => null],
    ["an unrecognised reply", async () => ({ nope: 1 })],
    ["a rejected promise", async () => Promise.reject(new Error("boom"))],
    [
      "a missing receiving end",
      async () => {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
    ]
  ])("%s to a hello is no answer: instance, marker and listener stay", async (_name, answer) => {
    const instance = mount();
    await flush();
    fake.runtime.sendMessage = async (message: unknown) => {
      fake.sentRuntimeMessages.push(message);
      return answer();
    };
    for (const nonce of ["n-1", "n-2"]) {
      posts.length = 0;
      hello(nonce);
      await flush();
      expect(hellos()).toHaveLength(1); // still listening and answering from cache
      expect(states()).toHaveLength(1);
    }
    expect(hosts()).toHaveLength(1);
    expect(document.documentElement.dataset.webSipPhone).toBe("9.9.9");
    expect(fake.runtime.onMessage.listeners).toHaveLength(1);
    void instance;
  });

  it("an unusable ui/getState reply does not tear anything down", async () => {
    reply = undefined;
    mount();
    await flush();
    expect(hosts()).toHaveLength(1);
    expect(document.documentElement.dataset.webSipPhone).toBe("9.9.9");
  });

  describe("re-check", () => {
    const checkIns = () => fake.sentRuntimeMessages.filter((m) => (m as Msg).type === "site/checkIn");
    const recheck = () => fake.runtime.onMessage.fire({ target: "content", type: "site/recheck" }, {}, () => {});
    /** Have the worker answer a check-in with `verdict`; `null` rejects as a sleeping worker would. */
    function answerCheckIn(verdict: unknown): void {
      const inner = fake.runtime.sendMessage;
      fake.runtime.sendMessage = async (message: unknown) => {
        if ((message as Msg).type !== "site/checkIn") {
          return inner(message);
        }
        fake.sentRuntimeMessages.push(message);
        if (verdict === null) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        return verdict;
      };
    }

    it("answers a site/recheck by checking in, and withdraws on a site/revoked verdict", async () => {
      const instance = mount();
      await flush();
      answerCheckIn({ target: "content", type: "site/revoked" });
      recheck();
      await flush();
      expect(checkIns()).toEqual([{ target: "background", type: "site/checkIn" }]);
      expectGone(instance);
    });

    it.each([
      ["no verdict (still allowed)", undefined],
      ["an unrecognised reply", { nope: 1 }],
      ["a sleeping worker", null]
    ])("%s leaves the instance in place", async (_name, verdict) => {
      const instance = mount();
      await flush();
      answerCheckIn(verdict);
      recheck();
      await flush();
      expect(checkIns()).toHaveLength(1);
      expect(instance.disposed).toBe(false);
      expect(hosts()).toHaveLength(1);
      expect(document.documentElement.dataset.webSipPhone).toBe("9.9.9");
    });
  });

  it("a site/revoked message from the worker tears the instance down without any hello", async () => {
    const instance = mount();
    await flush();
    fake.runtime.onMessage.fire({ target: "content", type: "site/revoked" }, {}, () => {});
    expectGone(instance);
    posts.length = 0;
    hello();
    await flush();
    expect(posts).toEqual([]);
  });
});

describe("replacement", () => {
  it("a new instance replaces an orphaned one: one widget, one hello reply, fresh state", async () => {
    const old = mount();
    await flush();
    // The orphan has not noticed yet (it has made no chrome call since the reload). The new
    // instance runs in a fresh context, which the fake models by restoring a working runtime.
    const workingSend = fake.runtime.sendMessage;
    invalidate();
    (fake.runtime as { id: string | undefined }).id = "fake-id";
    fake.runtime.sendMessage = workingSend;
    reply = { state: displayState({ link: { ...IDLE_LINK, registration: "connecting", microphone: "ok" } }), pos: null };
    posts.length = 0;

    const next = mount();
    expect(old.disposed).toBe(true);
    expect(next.disposed).toBe(false);
    expect(hosts()).toHaveLength(1);
    expect(document.documentElement.dataset.webSipPhone).toBe("9.9.9");
    expect(fake.runtime.onMessage.listeners).toHaveLength(1);

    // Announced to the page without it saying hello again.
    await flush();
    expect(states()).toEqual([expect.objectContaining({ registration: "REGISTERING" })]);

    hello("n-2");
    await flush();
    expect(hellos()).toHaveLength(1);
  });

  it("removes a leftover host from a script that predates the replace event", async () => {
    const stale = document.createElement("div");
    stale.id = HOST_ID;
    document.documentElement.appendChild(stale);
    mount();
    expect(stale.isConnected).toBe(false);
    expect(hosts()).toHaveLength(1);
  });

  it("injecting the same live script twice leaves exactly one live instance", async () => {
    const first = mount();
    await flush();
    const second = mount();
    await flush();
    expect(first.disposed).toBe(true);
    expect(hosts()).toHaveLength(1);
    expect(document.documentElement.dataset.webSipPhone).toBe("9.9.9");
    expect(fake.runtime.onMessage.listeners).toHaveLength(1);

    posts.length = 0;
    hello();
    await flush();
    expect(hellos()).toHaveLength(1);

    // A broadcast reaches only the live instance's view and bridge.
    fake.runtime.onMessage.fire(
      { target: "content", type: "state/update", state: displayState({ error: "CONNECTION_LOST" }), pos: null },
      {},
      () => {}
    );
    expect(states().filter((s) => s.error === "WSS_LOST")).toHaveLength(1);
    expect(second.disposed).toBe(false);
  });

  it("an old instance torn down later does not take the new instance's marker with it", async () => {
    const first = mount();
    const second = mount();
    first.teardown();
    expect(second.disposed).toBe(false);
    expect(document.documentElement.dataset.webSipPhone).toBe("9.9.9");
    expect(hosts()).toHaveLength(1);
  });
});

describe("page-controlled visibility", () => {
  it("an undeclared page shows the widget at once, whatever the page says", async () => {
    mount();
    expect(shown()).toBe(true);
    await flush();
    hello();
    deprovision();
    await flush();
    expect(shown()).toBe(true);
    expect(hostEl().dataset.mode).toBe("always");
  });

  it("a declared page is hidden until hello, hides again on deprovision, and shows on the next hello", async () => {
    declare();
    mount();
    expect(shown()).toBe(false);
    await flush();
    expect(shown()).toBe(false);

    hello();
    expect(shown()).toBe(true); // before the worker has answered
    await flush();
    expect(shown()).toBe(true);

    deprovision();
    expect(shown()).toBe(false);
    hello("n-2");
    expect(shown()).toBe(true);
  });

  it("a malformed declaration leaves the widget shown", () => {
    declare("widget=pages");
    mount();
    expect(shown()).toBe(true);
  });

  it("a declared page that never says hello still shows a call from ring to hang-up, then hides", async () => {
    declare();
    mount();
    await flush();
    expect(shown()).toBe(false);
    broadcast(busy()); // ringing
    expect(shown()).toBe(true);
    broadcast(busy()); // answered
    expect(shown()).toBe(true);
    broadcast(displayState({ busy: false })); // ended
    expect(shown()).toBe(false);
  });

  it("hello and then call end stays shown; deprovision during a call hides only once the call ends", async () => {
    declare();
    mount();
    await flush();
    hello();
    broadcast(busy());
    broadcast(displayState());
    expect(shown()).toBe(true);

    broadcast(busy());
    deprovision();
    expect(shown()).toBe(true);
    broadcast(displayState());
    expect(shown()).toBe(false);
  });

  it("each tab follows its own page; a call shows in both", async () => {
    // Two content scripts cannot share one jsdom document, so each is exercised in turn. The
    // state is per-instance (closures in mountWebSipPhone, nothing module-level), and the
    // broadcast reaches every tab, which is what the last step models.
    declare();
    const agent = mount();
    await flush();
    hello();
    expect(shown()).toBe(true);
    agent.teardown();

    const admin = mount();
    await flush();
    expect(shown()).toBe(false); // no hello in this tab: the first tab's hello did not leak
    broadcast(busy());
    expect(shown()).toBe(true);
    expect(admin.disposed).toBe(false);
  });

  it("a reload during an active call goes from hidden-at-creation straight to visible, never back", async () => {
    declare();
    reply = { state: busy(), pos: null };
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(shown() ? "shown" : "hidden"));
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const appended = vi.spyOn(document.documentElement, "appendChild");
    mount();
    // Hidden before it was ever attached: no first frame with the widget on screen.
    const host = appended.mock.calls.map((c) => c[0] as HTMLElement).find((el) => el.id === HOST_ID)!;
    expect(host.style.display).toBe("none");
    await flush();
    broadcast(busy());
    await flush();
    observer.disconnect();
    expect(shown()).toBe(true);
    expect(seen).toContain("shown");
    expect(seen.join(",")).not.toMatch(/shown,hidden/);
  });

  it("closing the panel on hide sends panelState false", async () => {
    declare();
    mount();
    await flush();
    hello();
    hostEl().shadowRoot!.querySelector<HTMLElement>('[data-role="dot"]')!.click();
    expect(fake.sentRuntimeMessages).toContainEqual({ target: "background", type: "ui/panelState", open: true });
    deprovision();
    expect(shown()).toBe(false);
    expect(fake.sentRuntimeMessages.at(-1)).toEqual({ target: "background", type: "ui/panelState", open: false });
  });

  it("ignores a meta added after mount, and a declaration removed after mount", async () => {
    mount();
    declare();
    await flush();
    expect(shown()).toBe(true);
    deprovision();
    expect(shown()).toBe(true);
    mounted.pop()!.teardown();
    document.head.querySelectorAll('meta[name="web-sip-phone"]').forEach((el) => el.remove());

    const meta = declare();
    mount();
    meta.remove();
    await flush();
    expect(shown()).toBe(false);
    hello();
    expect(shown()).toBe(true);
    deprovision();
    expect(shown()).toBe(false);
  });
});

describe("visibility across instance replacement", () => {
  it("an instance that saw hello hands that on without the page saying hello again", async () => {
    declare();
    mount();
    await flush();
    hello();
    mount();
    expect(shown()).toBe(true);
    expect(hostEl().dataset.hello).toBe("1");
  });

  it("an instance that never saw hello hands on a hidden widget", async () => {
    declare();
    mount();
    await flush();
    mount();
    expect(shown()).toBe(false);
    expect(hostEl().dataset.hello).toBeUndefined();
  });

  it("a deprovisioned instance does not hand hello on", async () => {
    declare();
    mount();
    await flush();
    hello();
    deprovision();
    mount();
    expect(shown()).toBe(false);
  });

  it("a host from 1.1.0 or earlier (no data-mode) counts as shown, so an agent's phone survives the update", () => {
    const legacy = document.createElement("div");
    legacy.id = HOST_ID;
    document.documentElement.appendChild(legacy);
    declare();
    mount();
    expect(shown()).toBe(true);
  });
});

describe("activation of a prerendered page", () => {
  const retries = () => fake.sentRuntimeMessages.filter((m) => (m as Msg).type === "ui/retry");
  const getStates = () => fake.sentRuntimeMessages.filter((m) => (m as Msg).type === "ui/getState");
  let visibility: "hidden" | "visible";

  beforeEach(() => {
    visibility = "hidden";
    Object.defineProperty(document, "prerendering", { configurable: true, value: true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });

  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).prerendering;
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  /** Mount while prerendering with the worker having answered REGISTERING, then activate. */
  async function activate(fresh: unknown): Promise<void> {
    reply = { state: displayState({ runtime: RuntimeState.Registering }), pos: null };
    mount();
    await flush();
    reply = fresh;
    Object.defineProperty(document, "prerendering", { configurable: true, value: false });
    visibility = "visible";
    document.dispatchEvent(new Event("prerenderingchange"));
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
  }

  it("does not retry on the state cached during prerender when the fresh state is healthy", async () => {
    await activate({ state: displayState(), pos: null });
    expect(getStates()).toHaveLength(2);
    expect(retries()).toHaveLength(0);
    // The cached state no longer blocks later nudges either.
    await vi.advanceTimersByTimeAsync(20_000);
    window.dispatchEvent(new Event("focus"));
    expect(retries()).toHaveLength(0);
  });

  it("nudges exactly once when the fresh state is unhealthy", async () => {
    await activate({ state: displayState({ runtime: RuntimeState.Registering }), pos: null });
    expect(retries()).toHaveLength(1);
    window.dispatchEvent(new Event("focus"));
    expect(retries()).toHaveLength(1);
  });

  it("nudges for a fresh error state", async () => {
    await activate({ state: displayState({ error: "registration failed" as never }), pos: null });
    expect(retries()).toHaveLength(1);
  });

  it("does not nudge from the stale state when the worker gives no answer", async () => {
    await activate(null);
    expect(retries()).toHaveLength(0);
    window.dispatchEvent(new Event("focus"));
    expect(retries()).toHaveLength(0);
  });

  it("a broadcast after activation makes the state trustworthy again", async () => {
    await activate(null);
    broadcast(displayState({ runtime: RuntimeState.Registering }));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(retries()).toHaveLength(1);
  });

  it("a normal page still nudges on an unhealthy state", async () => {
    delete (document as unknown as Record<string, unknown>).prerendering;
    visibility = "visible";
    reply = { state: displayState({ runtime: RuntimeState.Registering }), pos: null };
    mount();
    await flush();
    expect(retries()).toHaveLength(1);
  });

  it("checks in on activation, and withdraws if its site went away while it was prerendering", async () => {
    // A re-check sent during prerender never reached this document: activation is its turn.
    const inner = fake.runtime.sendMessage;
    fake.runtime.sendMessage = async (message: unknown) =>
      (message as Msg).type === "site/checkIn"
        ? (fake.sentRuntimeMessages.push(message), { target: "content", type: "site/revoked" })
        : inner(message);
    await activate({ state: displayState(), pos: null });
    expect(fake.sentRuntimeMessages.filter((m) => (m as Msg).type === "site/checkIn")).toHaveLength(1);
    expect(mounted[0].disposed).toBe(true);
    expect(hosts()).toHaveLength(0);
  });

  it("removes the activation listener on teardown", async () => {
    const rm = vi.spyOn(document, "removeEventListener");
    const instance = mount();
    instance.teardown();
    expect(rm.mock.calls.map((c) => c[0])).toContain("prerenderingchange");
  });
});
