import type { ProvisionRequest } from "../shared/page-protocol.js";

/**
 * A credential pushed in by an allowed host page, plus the origin that pushed it.
 *
 * Session storage only: a provisioned credential is bound to the browser session that the host
 * page authenticated in, and `chrome.storage.local` is where the *manual* account lives — a
 * provisioned a1Hash written there would outlive the session and survive into the Options form.
 * It is kept out of memory alone because an MV3 worker is killed freely; session storage dies
 * with the browser, which is exactly the lifetime wanted.
 */
export interface ProvisionedCredential extends ProvisionRequest {
  /** Origin of the host page that provisioned this credential, e.g. "https://crm.example.com". */
  origin: string;
  /**
   * Epoch ms at which this credential was accepted — the "last sync" the Options banner shows.
   * It is the extension's own clock, not the page's: the page controls `expiresAt`, and a
   * "last sync" taken from the page would be a claim rather than an observation.
   */
  receivedAt: number;
}

export const PROVISIONED_KEY = "websipphone.provisioned";

/** Returns null when nothing is stored, or when what is stored has already expired. */
export async function loadProvisioned(): Promise<ProvisionedCredential | null> {
  const items = await chrome.storage.session.get(PROVISIONED_KEY);
  const stored = items[PROVISIONED_KEY] as ProvisionedCredential | undefined;
  if (!stored) {
    return null;
  }
  return stored.expiresAt > Date.now() ? stored : null;
}

export async function saveProvisioned(credential: ProvisionedCredential): Promise<void> {
  await chrome.storage.session.set({ [PROVISIONED_KEY]: credential });
}

export async function clearProvisioned(): Promise<void> {
  await chrome.storage.session.remove(PROVISIONED_KEY);
}
