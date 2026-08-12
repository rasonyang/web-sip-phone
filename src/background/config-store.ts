import { DEFAULT_CONFIG, type WebSipPhoneConfig } from "../shared/config.js";

/**
 * Per-field storage keys. Writers (options page, service worker) live in different JS
 * contexts, so a single-key read-merge-write would let one context's save clobber another's
 * concurrent save of an unrelated field. Splitting into per-field keys means a patch only
 * ever touches the keys it actually changes.
 */
const KEYS = {
  account: "websipphone.account",
  allowSites: "websipphone.allowSites",
  turn: "websipphone.turn",
  dotPosition: "websipphone.dotPosition"
} as const;

const ALL_KEYS = Object.values(KEYS);

export async function loadConfig(): Promise<WebSipPhoneConfig> {
  const items = await chrome.storage.local.get(ALL_KEYS);
  return {
    account: (items[KEYS.account] as WebSipPhoneConfig["account"] | undefined) ?? DEFAULT_CONFIG.account,
    allowSites: (items[KEYS.allowSites] as WebSipPhoneConfig["allowSites"] | undefined) ?? DEFAULT_CONFIG.allowSites,
    turn: (items[KEYS.turn] as WebSipPhoneConfig["turn"] | undefined) ?? DEFAULT_CONFIG.turn,
    dotPosition: (items[KEYS.dotPosition] as WebSipPhoneConfig["dotPosition"] | undefined) ?? DEFAULT_CONFIG.dotPosition
  };
}

export async function saveConfig(patch: Partial<WebSipPhoneConfig>): Promise<WebSipPhoneConfig> {
  const toWrite: Record<string, unknown> = {};
  if ("account" in patch) toWrite[KEYS.account] = patch.account;
  if ("allowSites" in patch) toWrite[KEYS.allowSites] = patch.allowSites;
  if ("turn" in patch) toWrite[KEYS.turn] = patch.turn;
  if ("dotPosition" in patch) toWrite[KEYS.dotPosition] = patch.dotPosition;
  if (Object.keys(toWrite).length > 0) {
    await chrome.storage.local.set(toWrite);
  }
  return loadConfig();
}

/** Sign out: clearing the account also clears TURN credentials (design.md §19). */
export async function clearAccount(): Promise<WebSipPhoneConfig> {
  return saveConfig({ account: null, turn: null });
}
