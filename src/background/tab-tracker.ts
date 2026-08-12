import { urlMatchesAllowSite } from "../shared/allow-sites.js";

/** Tracks which open tabs are top-level Allow Site pages. Window count is irrelevant; tabs are global. */
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
      if (changeInfo.url === undefined && changeInfo.status !== "loading") {
        return;
      }
      this.evaluate(tabId, changeInfo.url ?? tab.url);
    });
    await this.refresh();
  }

  /** Re-scan all tabs; call after the Allow Sites list changes. */
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

  isLast(tabId: number): boolean {
    return this.tabs.size === 1 && this.tabs.has(tabId);
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
