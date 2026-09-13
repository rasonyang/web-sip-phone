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
  const tabsOnUpdated = new FakeEvent<[number, { url?: string; status?: string }, FakeTab]>();
  const sentTabMessages: Array<{ tabId: number; message: unknown }> = [];

  const runtimeOnMessage = new FakeEvent<[unknown, unknown, (response?: unknown) => void]>();
  const runtimeOnInstalled = new FakeEvent<[{ reason: string }]>();
  const permissionsOnRemoved = new FakeEvent<[{ origins?: string[] }]>();
  const sentRuntimeMessages: unknown[] = [];

  const registeredScripts: Array<{ id: string; matches: string[] }> = [];
  const executedScripts: Array<{ target: { tabId: number; allFrames?: boolean }; files: string[] }> = [];

  const permissionRequests: unknown[] = [];
  const permissionRemovals: unknown[] = [];
  const removedTabs: number[] = [];

  const fake = {
    _localData: localData,
    _sessionData: sessionData,
    _tabs: tabs,
    _openTab(id: number, url: string) {
      tabs.push({ id, url });
      tabsOnUpdated.fire(id, { url, status: "loading" }, { id, url });
    },
    _closeTab(id: number) {
      const i = tabs.findIndex((t) => t.id === id);
      if (i >= 0) tabs.splice(i, 1);
      tabsOnRemoved.fire(id);
    },
    _navigateTab(id: number, url: string) {
      const tab = tabs.find((t) => t.id === id);
      if (tab) tab.url = url;
      tabsOnUpdated.fire(id, { url, status: "loading" }, { id, url });
    },
    _grantPermissions: true,
    _offscreenOpen: false,
    optionsOpened: 0,
    sentTabMessages,
    sentRuntimeMessages,
    registeredScripts,
    executedScripts,
    /** Origins (`https://host/*`) the user has granted; null grants everything. */
    _grantedOrigins: null as string[] | null,
    /** Tab ids whose injection fails, as a closed or error-page tab would. */
    _failInjectTabs: new Set<number>(),
    permissionRequests,
    permissionRemovals,
    removedTabs,
    /** Tab returned by tabs.getCurrent(); undefined outside a tab-hosted page. */
    _currentTab: undefined as FakeTab | undefined,

    storage: {
      local: {
        get: async (key: string | string[]) => {
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
        get: async (key: string) => (key in sessionData ? { [key]: sessionData[key] } : {}),
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
      query: async () => tabs.map((t) => ({ id: t.id, url: t.url })),
      sendMessage: async (tabId: number, message: unknown) => {
        sentTabMessages.push({ tabId, message });
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
        registeredScripts.push(...scripts);
      },
      unregisterContentScripts: async (filter: { ids: string[] }) => {
        for (const id of filter.ids) {
          const i = registeredScripts.findIndex((s) => s.id === id);
          if (i >= 0) registeredScripts.splice(i, 1);
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
      request: async (perms: unknown) => {
        permissionRequests.push(perms);
        return fake._grantPermissions;
      },
      remove: async (perms: unknown) => {
        permissionRemovals.push(perms);
        return true;
      },
      onRemoved: permissionsOnRemoved,
      contains: async (perms: { origins?: string[] }) =>
        fake._grantedOrigins === null || (perms.origins ?? []).every((o) => fake._grantedOrigins!.includes(o))
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
