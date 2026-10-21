type Listener<T extends unknown[]> = (...args: T) => void;

class FakeEvent<T extends unknown[]> {
  listeners: Listener<T>[] = [];
  addListener(cb: Listener<T>): void {
    this.listeners.push(cb);
  }
  removeListener(cb: Listener<T>): void {
    this.listeners = this.listeners.filter((l) => l !== cb);
  }
  fire(...args: T): void {
    for (const l of [...this.listeners]) l(...args);
  }
}

export interface FakeTab {
  id: number;
  /** The real URL. What the extension is shown of it depends on its host permissions (see `scrub`). */
  url: string;
  /** Set only on a tab a page opened; the options page uses it to decide whether to close itself. */
  openerTabId?: number;
}

export function installFakeChrome() {
  const localData: Record<string, unknown> = {};
  const sessionData: Record<string, unknown> = {};
  const onChanged = new FakeEvent<[Record<string, chrome.storage.StorageChange>, string]>();

  const tabs: FakeTab[] = [];
  const tabsOnRemoved = new FakeEvent<[number]>();
  const tabsOnUpdated = new FakeEvent<[number, { url?: string; status?: string }, { id: number; url?: string }]>();
  const sentTabMessages: Array<{ tabId: number; message: unknown; options?: unknown }> = [];

  const runtimeOnMessage = new FakeEvent<[unknown, unknown, (response?: unknown) => void]>();
  const runtimeOnInstalled = new FakeEvent<[{ reason: string }]>();
  const permissionsOnRemoved = new FakeEvent<[{ origins?: string[] }]>();
  const sentRuntimeMessages: unknown[] = [];

  const registeredScripts: Array<{ id: string; matches: string[] }> = [];
  const executedScripts: Array<{ target: { tabId: number; allFrames?: boolean }; files: string[] }> = [];

  const permissionRequests: unknown[] = [];
  const permissionRemovals: unknown[] = [];
  const removedTabs: number[] = [];

  /**
   * Like Chrome for an extension without the `tabs` permission: a URL is shown only for an origin
   * the extension has host permission for, and for its own pages. Everything else comes back
   * with no `url` (and, in Chrome, no `title` or `favIconUrl`, which this fake never models).
   */
  const urlVisible = (url: string): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    return parsed.protocol === "chrome-extension:" || originGranted(`${parsed.origin}/*`);
  };
  const originGranted = (pattern: string): boolean =>
    !fake._revokedOrigins.has(pattern) && (fake._grantedOrigins === null || fake._grantedOrigins.includes(pattern));
  const scrub = (tab: FakeTab): { id: number; url?: string } =>
    urlVisible(tab.url) ? { id: tab.id, url: tab.url } : { id: tab.id };
  /** onUpdated as Chrome fires it on a commit: `changeInfo.url` only when the new URL is visible. */
  const fireLoading = (tab: FakeTab): void => {
    tabsOnUpdated.fire(tab.id, urlVisible(tab.url) ? { url: tab.url, status: "loading" } : { status: "loading" }, scrub(tab));
  };

  const fake = {
    _localData: localData,
    _sessionData: sessionData,
    _tabs: tabs,
    _openTab(id: number, url: string) {
      const tab = { id, url };
      tabs.push(tab);
      fireLoading(tab);
    },
    _closeTab(id: number) {
      const i = tabs.findIndex((t) => t.id === id);
      if (i >= 0) tabs.splice(i, 1);
      tabsOnRemoved.fire(id);
    },
    _navigateTab(id: number, url: string) {
      const tab = tabs.find((t) => t.id === id) ?? { id, url };
      tab.url = url;
      fireLoading(tab);
    },
    /**
     * The `MessageSender` Chrome attaches to a message from the top frame of tab `id`. Never
     * scrubbed, whatever the permissions: `tab` keeps its URL and `url` is always set.
     */
    _senderFor(id: number, extra: Record<string, unknown> = {}) {
      const url = tabs.find((t) => t.id === id)?.url;
      return { tab: { id, url }, url, frameId: 0, ...extra };
    },
    /**
     * Stands in for the content script(s) of a tab: what `tabs.sendMessage` resolves with. Unset,
     * every message is delivered and answered with nothing.
     */
    _tabMessageHandler: null as ((tabId: number, message: unknown) => unknown) | null,
    _grantPermissions: true,
    _offscreenOpen: false,
    optionsOpened: 0,
    sentTabMessages,
    sentRuntimeMessages,
    registeredScripts,
    executedScripts,
    /** Origins (`https://host/*`) the user has granted; null grants everything. */
    _grantedOrigins: null as string[] | null,
    /** Origins taken away since, by `permissions.remove`: they stay revoked whatever the above says. */
    _revokedOrigins: new Set<string>(),
    /** Tab ids whose injection fails, as a closed or error-page tab would. */
    _failInjectTabs: new Set<number>(),
    permissionRequests,
    permissionRemovals,
    removedTabs,
    /** Tab returned by tabs.getCurrent(); undefined outside a tab-hosted page. */
    _currentTab: undefined as FakeTab | undefined,
    /** While set, every storage read waits on it: a worker that has woken but not yet loaded. */
    _storageGate: null as Promise<void> | null,

    storage: {
      local: {
        get: async (key: string | string[]) => {
          await fake._storageGate;
          const keys = Array.isArray(key) ? key : [key];
          const result: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in localData) result[k] = localData[k];
          }
          return result;
        },
        set: async (items: Record<string, unknown>) => {
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: localData[k], newValue: v };
            localData[k] = v;
          }
          onChanged.fire(changes, "local");
        },
        remove: async (key: string) => {
          delete localData[key];
        }
      },
      session: {
        get: async (key: string) => {
          await fake._storageGate;
          return key in sessionData ? { [key]: sessionData[key] } : {};
        },
        set: async (items: Record<string, unknown>) => {
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: sessionData[k], newValue: v };
            sessionData[k] = v;
          }
          onChanged.fire(changes, "session");
        },
        remove: async (key: string) => {
          delete sessionData[key];
        }
      },
      onChanged
    },

    tabs: {
      query: async () => tabs.map(scrub),
      sendMessage: async (tabId: number, message: unknown, options?: unknown) => {
        sentTabMessages.push({ tabId, message, ...(options === undefined ? {} : { options }) });
        return fake._tabMessageHandler?.(tabId, message);
      },
      getCurrent: async () => fake._currentTab,
      remove: async (id: number) => {
        removedTabs.push(id);
      },
      onRemoved: tabsOnRemoved,
      onUpdated: tabsOnUpdated
    },

    runtime: {
      // Returns unknown so a test can stand in a responder (e.g. the offscreen mic test).
      sendMessage: async (message: unknown): Promise<unknown> => {
        sentRuntimeMessages.push(message);
        return undefined;
      },
      onMessage: runtimeOnMessage,
      onInstalled: runtimeOnInstalled,
      openOptionsPage: async () => {
        fake.optionsOpened++;
      },
      getContexts: async () => (fake._offscreenOpen ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
      getManifest: () => ({ version: "9.9.9" }),
      getURL: (path: string) => `chrome-extension://fake-id/${path}`,
      id: "fake-id"
    },

    scripting: {
      registerContentScripts: async (scripts: Array<{ id: string; matches: string[] }>) => {
        // Like Chrome: one script per id, and the whole call is rejected on a duplicate.
        for (const { id } of scripts) {
          if (registeredScripts.some((r) => r.id === id)) {
            throw new Error(`Duplicate script ID '${id}'`);
          }
        }
        registeredScripts.push(...scripts);
      },
      unregisterContentScripts: async (filter: { ids: string[] }) => {
        for (const id of filter.ids) {
          if (!registeredScripts.some((s) => s.id === id)) {
            throw new Error(`Nonexistent script ID '${id}'`);
          }
        }
        for (const id of filter.ids) {
          registeredScripts.splice(registeredScripts.findIndex((s) => s.id === id), 1);
        }
      },
      getRegisteredContentScripts: async () => [...registeredScripts],
      executeScript: async (injection: { target: { tabId: number; allFrames?: boolean }; files: string[] }) => {
        if (fake._failInjectTabs.has(injection.target.tabId)) {
          throw new Error(`Cannot access contents of tab ${injection.target.tabId}`);
        }
        executedScripts.push(injection);
        return [];
      }
    },

    permissions: {
      request: async (perms: { origins?: string[] }) => {
        permissionRequests.push(perms);
        if (fake._grantPermissions) {
          for (const o of perms.origins ?? []) {
            fake._revokedOrigins.delete(o);
            if (fake._grantedOrigins !== null && !fake._grantedOrigins.includes(o)) {
              fake._grantedOrigins.push(o);
            }
          }
        }
        return fake._grantPermissions;
      },
      // Takes effect at once, like Chrome's: the next tabs.query no longer shows those tabs' URLs.
      // Chrome also fires onRemoved; a test fires it itself, when it wants the worker to hear.
      remove: async (perms: { origins?: string[] }) => {
        permissionRemovals.push(perms);
        for (const o of perms.origins ?? []) {
          fake._revokedOrigins.add(o);
          if (fake._grantedOrigins !== null) {
            fake._grantedOrigins = fake._grantedOrigins.filter((g) => g !== o);
          }
        }
        return true;
      },
      onRemoved: permissionsOnRemoved,
      contains: async (perms: { origins?: string[] }) => (perms.origins ?? []).every(originGranted)
    },

    offscreen: {
      createDocument: async () => {
        fake._offscreenOpen = true;
      },
      closeDocument: async () => {
        fake._offscreenOpen = false;
      }
    }
  };

  (globalThis as Record<string, unknown>).chrome = fake;
  return fake;
}

export type FakeChrome = ReturnType<typeof installFakeChrome>;
