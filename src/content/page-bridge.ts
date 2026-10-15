import type { Msg, TabState } from "../shared/messages.js";
import {
  EXTENSION_SOURCE,
  PROTOCOL_VERSION,
  parsePageMessage,
  toPageState,
  type PageOutbound,
  type ProvisionRequest
} from "../shared/page-protocol.js";
import type { DisplayState } from "../shared/state.js";

/** Everything the bridge touches from the outside, injected so it can be driven in a test. */
export interface PageBridgeEnv {
  /** The page window: both the only accepted message source and the postMessage target. */
  win: Window;
  /** Extension version, published to the page as the presence marker and in the hello reply. */
  version: string;
  extensionId: string;
  /** Fire-and-forget to the service worker. */
  send: (msg: Msg) => void;
  /**
   * Ask the service worker for the current tab state. Three outcomes, and the difference
   * matters: a `TabState` is state to publish, `"declined"` is the worker's explicit refusal
   * (it answered `{ declined: true }` — this site is no longer an Allow Site), and `null` is no
   * answer at all (worker asleep, unreachable, or an empty or unrecognised reply), which says
   * nothing about whether the site is allowed.
   */
  request: (msg: Msg) => Promise<TabState | null | "declined">;
  /**
   * False once the extension context behind this content script is gone (reload, update,
   * disable). Checked before answering anything: an orphaned script would otherwise reply to a
   * hello with the version and state it froze at. Absent means always alive.
   */
  alive?: () => boolean;
  /**
   * The worker explicitly declined a hello: this site is no longer an Allow Site. The owner tears
   * down everything it built (the bridge included). Absent, the bridge withdraws only itself —
   * the marker and its own listener.
   */
  onDeclined?: () => void;
  /**
   * This page sent a valid `hello` — fired before the worker is asked anything, so a page that
   * controls the widget's visibility sees it appear at once. A decline still tears it all down.
   */
  onHello?: () => void;
  /** This page sent a valid `deprovision`. */
  onDeprovision?: () => void;
  /**
   * True while the document is being prerendered (the browser runs it before the user has
   * navigated to it). Absent, read from `win.document.prerendering`.
   */
  prerendering?: () => boolean;
}

/** What a page asked for during prerender, held until the document is activated. */
type HeldOrder = { kind: "provision"; credential: ProvisionRequest } | { kind: "deprovision" };

/**
 * Relays the page ↔ extension provisioning protocol between the host page and the service
 * worker (see page-protocol.ts).
 *
 * Two rules hold the security line here. Inbound, an event is only considered when it came
 * from this very window at this very origin — an iframe, an opener, or any other origin is
 * dropped without a reply, so a cross-origin frame cannot even probe for the extension.
 * Outbound, nothing but a validated credential crosses into the extension and nothing but
 * mapped registration state crosses back out; the credential itself is handed straight to the
 * worker, so a later hello cannot read back what a page once pushed in. The one exception is a
 * provision posted while the document is still being prerendered: the worker refuses
 * speculative documents, so it is held in a private field until activation, sent once, and
 * cleared there (or on detach). It is never echoed to the page.
 */
export class PageBridge {
  private readonly env: PageBridgeEnv;
  /** Last state handed to publish(), replayed to a page that says hello. Never a secret. */
  private last: DisplayState | null = null;
  /** Serialised form of the last state actually posted, for change detection. */
  private lastPosted: string | null = null;
  private listening = false;
  /** A worker check is owed: a hello arrived while prerendering and none has been sent since. */
  private helloOwed = false;
  /** The latest provision/deprovision posted while prerendering; a later one replaces it. */
  private held: HeldOrder | null = null;

  constructor(env: PageBridgeEnv) {
    this.env = env;
  }

  /**
   * Marks presence and starts listening. The marker is set synchronously on injection so a page
   * that loads before its own script runs can already see the extension is there.
   */
  attach(): void {
    const root = this.env.win.document.documentElement;
    root.dataset.webSipPhone = this.env.version;
    if (!this.listening) {
      this.env.win.addEventListener("message", this.onMessage);
      this.env.win.document.addEventListener("prerenderingchange", this.onActivated);
      this.listening = true;
    }
  }

  detach(): void {
    if (this.listening) {
      this.env.win.removeEventListener("message", this.onMessage);
      this.env.win.document.removeEventListener("prerenderingchange", this.onActivated);
      this.listening = false;
    }
    // Nothing owed to a bridge that is gone, and a held credential must not outlive it.
    this.helloOwed = false;
    this.held = null;
  }

  private isPrerendering(): boolean {
    if (this.env.prerendering) {
      return this.env.prerendering();
    }
    return (this.env.win.document as Document & { prerendering?: boolean }).prerendering === true;
  }

  /**
   * The prerendered document became the visible page. Ask the worker once about every hello
   * seen meanwhile, then hand over whatever provision/deprovision was held — in that order, so
   * the worker has judged the site before it is given a credential. The held order goes only
   * if the check did not end the bridge (a decline detaches and clears it).
   */
  private readonly onActivated = (): void => {
    if (this.isPrerendering()) {
      return;
    }
    void this.activate();
  };

  private async activate(): Promise<void> {
    if (this.env.alive && !this.env.alive()) {
      this.detach();
      return;
    }
    if (this.helloOwed) {
      this.helloOwed = false;
      await this.checkWithWorker();
    }
    const held = this.held;
    this.held = null;
    if (held === null || !this.listening) {
      return;
    }
    this.env.send(
      held.kind === "provision"
        ? { target: "background", type: "page/provision", credential: held.credential }
        : { target: "background", type: "page/deprovision" }
    );
  }

  /**
   * Publish the current state to the page. Called on every state/update, which also fires for
   * things the page cannot see (a dot position save), so an unchanged page-facing state posts
   * nothing: the page contract is a message per change, not per internal update.
   */
  publish(state: DisplayState): void {
    this.last = state;
    const msg = toPageState(state);
    const json = JSON.stringify(msg);
    if (json === this.lastPosted) {
      return;
    }
    this.lastPosted = json;
    this.post(msg);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const win = this.env.win;
    // Same window, same origin, or it never happened.
    if (event.source !== win || event.origin !== win.location.origin) {
      return;
    }
    const inbound = parsePageMessage(event.data);
    if (inbound === null) {
      return;
    }
    if (this.env.alive && !this.env.alive()) {
      this.detach();
      return;
    }
    switch (inbound.type) {
      case "hello":
        this.env.onHello?.();
        this.post({
          source: EXTENSION_SOURCE,
          protocolVersion: PROTOCOL_VERSION,
          type: "hello",
          nonce: inbound.nonce,
          extensionVersion: this.env.version,
          extensionId: this.env.extensionId
        });
        if (this.isPrerendering()) {
          // Answered from what is known here; the worker is asked once, on activation.
          if (this.last !== null) {
            this.post(toPageState(this.last));
          }
          this.helloOwed = true;
        } else {
          void this.postCurrentState();
        }
        break;
      case "provision":
        if (this.isPrerendering()) {
          // Held, latest wins, sent on activation (see onActivated).
          this.held = { kind: "provision", credential: inbound.credential };
        } else {
          // Handed on immediately and deliberately not stored anywhere: once this returns, the
          // credential exists only inside the service worker. It also supersedes an order still
          // held from prerender (activation may be awaiting the worker), which must not follow it.
          this.held = null;
          this.env.send({ target: "background", type: "page/provision", credential: inbound.credential });
        }
        break;
      case "deprovision":
        if (this.isPrerendering()) {
          this.held = { kind: "deprovision" };
        } else {
          this.held = null;
          this.env.send({ target: "background", type: "page/deprovision" });
        }
        this.env.onDeprovision?.();
        break;
    }
  };

  /**
   * A hello is always answered with state — and always checked with the worker.
   *
   * A cached state is posted at once, so a page gets its answer even while the MV3 worker is
   * asleep, but the worker is asked regardless: the cache cannot tell that the site has since been
   * removed from Allow Sites, and a tab on a removed site gets no further broadcasts, so a cache
   * that answered on its own would keep claiming a registration forever. A fresh state that
   * matches the cached one posts nothing more (publish() de-duplicates).
   *
   * An explicit decline is the one case that ends the bridge. The presence marker means "the
   * extension is installed *and* this site is allowed", so it must not outlive the site's Allow
   * listing. No answer at all is not a refusal — an MV3 worker is routinely asleep — so that case
   * leaves the cached answer, the marker and the listener in place.
   */
  private async postCurrentState(): Promise<void> {
    if (this.last !== null) {
      this.post(toPageState(this.last));
    }
    await this.checkWithWorker();
  }

  /** The worker half of a hello: ask, then publish, tear down on a decline, or do nothing. */
  private async checkWithWorker(): Promise<void> {
    const ts = await this.env.request({ target: "background", type: "page/hello" });
    if (!this.listening) {
      return; // detached while the worker was answering (replaced, or the context went away)
    }
    if (ts === "declined") {
      if (this.env.onDeclined) {
        this.env.onDeclined();
      } else {
        delete this.env.win.document.documentElement.dataset.webSipPhone;
      }
      this.detach();
      return;
    }
    if (ts !== null) {
      this.publish(ts.state);
    }
  }

  private post(msg: PageOutbound): void {
    this.env.win.postMessage(msg, this.env.win.location.origin);
  }
}
