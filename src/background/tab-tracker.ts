import { urlMatchesAllowSite } from "../shared/allow-sites.js";

/**
 * Tracks which open tabs are top-level Allow Site pages. Window count is irrelevant; tabs are global.
 *
 * The extension holds no `tabs` permission, so Chrome shows a tab's URL only while the extension
 * has host permission for it. Everything here reads a missing URL as "not an Allow Site tab",
 * which is the truth: an unlisted site, or a listed one whose permission was revoked (the content
 * script cannot run there, so nothing on that tab needs the runtime).
 */
export class TabTracker {
  private tabs = new Set<number>();
  private listeners: Array<() => void> = [];

  constructor(private getAllowSites: () => string[]) {}

  async init(): Promise<void> {
    chrome.tabs.onRemoved.addListener((tabId) => {
      if (this.tabs.delete(tabId)) {
        this.emit();
      }
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      // Leaving an Allow Site for a site the extension has no permission for arrives scrubbed:
      // `{ status: "loading" }` with no `url`, and a `tab` with none either. That is a loading
      // event, so it is evaluated — and a missing URL drops the tab, as it should.
      if (changeInfo.url === undefined && changeInfo.status !== "loading") {
        return;
      }
      this.evaluate(tabId, changeInfo.url ?? tab.url);
    });
    await this.refresh();
  }

  /**
   * Re-scan all tabs; call after the Allow Sites list or a host permission changes. A tab whose
   * URL Chrome hides never counts.
   */
  async refresh(): Promise<void> {
    const all = await chrome.tabs.query({});
    this.tabs.clear();
    for (const t of all) {
      if (t.id !== undefined && t.url && urlMatchesAllowSite(t.url, this.getAllowSites())) {
        this.tabs.add(t.id);
      }
    }
    this.emit();
  }

  private evaluate(tabId: number, url: string | undefined): void {
    const matches = url !== undefined && urlMatchesAllowSite(url, this.getAllowSites());
    const had = this.tabs.has(tabId);
    if (matches) {
      this.tabs.add(tabId);
    } else {
      this.tabs.delete(tabId);
    }
    if (matches !== had) {
      this.emit();
    }
  }

  ids(): number[] {
    return [...this.tabs];
  }

  count(): number {
    return this.tabs.size;
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
