import type { Msg, TabState } from "../shared/messages.js";
import {
  EXTENSION_SOURCE,
  PROTOCOL_VERSION,
  parsePageMessage,
  toPageState,
  type PageOutbound
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
   * matters: a `TabState` is state to publish, `undefined` is an explicit decline (the worker
   * answered and refused — this site is no longer an Allow Site), and `null` is no answer at
   * all (worker asleep or unreachable), which says nothing about whether the site is allowed.
   */
  request: (msg: Msg) => Promise<TabState | null | undefined>;
}

/**
 * Relays the page ↔ extension provisioning protocol between the host page and the service
 * worker (see page-protocol.ts).
 *
 * Two rules hold the security line here. Inbound, an event is only considered when it came
 * from this very window at this very origin — an iframe, an opener, or any other origin is
 * dropped without a reply, so a cross-origin frame cannot even probe for the extension.
 * Outbound, nothing but a validated credential crosses into the extension and nothing but
 * mapped registration state crosses back out; the credential itself is handed straight to the
 * worker and never retained, so a later hello cannot read back what a page once pushed in.
 */
export class PageBridge {
  private readonly env: PageBridgeEnv;
  /** Last state handed to publish(), replayed to a page that says hello. Never a secret. */
  private last: DisplayState | null = null;
  /** Serialised form of the last state actually posted, for change detection. */
  private lastPosted: string | null = null;
  private listening = false;

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
      this.listening = true;
    }
  }

  detach(): void {
    if (this.listening) {
      this.env.win.removeEventListener("message", this.onMessage);
      this.listening = false;
    }
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
    switch (inbound.type) {
      case "hello":
        this.post({
          source: EXTENSION_SOURCE,
          protocolVersion: PROTOCOL_VERSION,
          type: "hello",
          nonce: inbound.nonce,
          extensionVersion: this.env.version,
          extensionId: this.env.extensionId
        });
        void this.postCurrentState();
        break;
      case "provision":
        // Handed on immediately and deliberately not stored anywhere: once this returns, the
        // credential exists only inside the service worker.
        this.env.send({ target: "background", type: "page/provision", credential: inbound.credential });
        break;
      case "deprovision":
        this.env.send({ target: "background", type: "page/deprovision" });
        break;
    }
  };

  /**
   * A hello is always answered with state: the cached one, or a fresh pull from the worker.
   *
   * An explicit decline is the one case that ends the bridge. The presence marker means "the
   * extension is installed *and* this site is allowed", so it must not outlive the site's Allow
   * listing: a content script already injected when the user removes the site keeps running, and
   * the worker's refusal is the only signal it gets. No answer at all is not a refusal — an MV3
   * worker is routinely asleep — so that case leaves the marker and the listener in place.
   */
  private async postCurrentState(): Promise<void> {
    if (this.last !== null) {
      this.post(toPageState(this.last));
      return;
    }
    const ts = await this.env.request({ target: "background", type: "page/hello" });
    if (ts === undefined) {
      delete this.env.win.document.documentElement.dataset.webSipPhone;
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
