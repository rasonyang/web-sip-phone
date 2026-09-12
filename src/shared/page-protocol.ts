import type { CredentialSource, DisplayState, ProvisionStatus } from "./state.js";

/**
 * The page ↔ extension provisioning protocol, version 1.
 *
 * A host page pushes a pre-hashed SIP credential in over window.postMessage; the extension
 * answers with registration state only. Nothing on the outbound side ever carries a secret,
 * and nothing on the inbound side is trusted until parsePageMessage has validated it.
 */
export const PROTOCOL_VERSION = 1 as const;
/** `source` on every page → extension message. */
export const PAGE_SOURCE = "aicc";
/** `source` on every extension → page message. */
export const EXTENSION_SOURCE = "web-sip-phone";

export interface ProvisionRequest {
  /** SIP realm the a1Hash was computed against. */
  sipDomain: string;
  /** WebSocket transport URL, used verbatim — the extension derives nothing from it. */
  wssUrl: string;
  account: string;
  /** md5(account:realm:password), 32 lowercase hex characters. */
  a1Hash: string;
  /**
   * Epoch ms after which the credential must not be used. On the wire this is an RFC 3339
   * date-time string (what `POST /agent/sip-session` returns, e.g. "2026-09-12T20:07:27Z");
   * a finite epoch-ms number is tolerated too. Normalised to a number here.
   */
  expiresAt: number;
}

/**
 * Parsed page → extension message. The wire form is flat — `provision` carries its five
 * credential fields on the message object itself — but it is normalised here into a nested
 * `credential` so the service worker receives exactly the validated set and nothing else.
 */
export type PageInbound =
  | { type: "hello"; nonce: string }
  | { type: "provision"; nonce: string; credential: ProvisionRequest }
  | { type: "deprovision" };

export type PageRegistration = "UNREGISTERED" | "REGISTERING" | "REGISTERED" | "FAILED";
export type PageMicrophone = "UNKNOWN" | "GRANTED" | "DENIED";
export type PageError = null | "REGISTRATION_FAILED" | "WSS_LOST" | "MIC_UNAVAILABLE" | "MEDIA_FAILED";

export interface PageState {
  source: typeof EXTENSION_SOURCE;
  protocolVersion: 1;
  type: "state";
  registration: PageRegistration;
  account: string | null;
  sipDomain: string | null;
  credentialSource: CredentialSource;
  /**
   * Added after v1 shipped (additive, still protocolVersion 1). NONE: nothing held. ACTIVE: a
   * provisioned credential is held and applied. OVERRIDDEN: one is held but the user's manual
   * account is applied — a page must not re-provision on seeing it.
   */
  provisionStatus: ProvisionStatus;
  microphone: PageMicrophone;
  error: PageError;
}

export interface PageHelloReply {
  source: typeof EXTENSION_SOURCE;
  protocolVersion: 1;
  type: "hello";
  nonce: string;
  extensionVersion: string;
  extensionId: string;
}

export type PageOutbound = PageState | PageHelloReply;

const A1_HASH = /^[0-9a-f]{32}$/;
// The SIP user part, restricted to RFC 3261's `user-unreserved` plus unreserved characters —
// no spaces, no "@", no ":" — so `sip:<account>@<domain>` is always a parseable URI. A value
// that is not would build a UA the registrar rejects forever, with nothing to retry against.
const ACCOUNT_RE = /^[A-Za-z0-9._~%!$&'()*+,;=-]+$/;
// A bare hostname: labels of letters/digits/hyphen, no scheme, no port, no path. The realm is
// half of what the a1Hash was computed over, so anything else cannot authenticate anyway.
const SIP_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isWsUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}

/**
 * Strict parse of the flat credential fields. Exported so the service worker can re-validate a
 * credential that reached it through the content-script relay instead of trusting the relay.
 */
/** RFC 3339 date-time string (the contract's wire form) or a finite epoch-ms number → epoch ms. */
function parseExpiresAt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string" && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}

export function parseProvisionRequest(value: unknown): ProvisionRequest | null {
  if (!isRecord(value)) {
    return null;
  }
  const { sipDomain, wssUrl, account, a1Hash, expiresAt } = value;
  if (!nonEmptyString(sipDomain) || !nonEmptyString(wssUrl) || !nonEmptyString(account)) {
    return null;
  }
  if (!isWsUrl(wssUrl)) {
    return null;
  }
  // Hostnames are case-insensitive; normalising here keeps one credential from looking like
  // two different ones to the restart-on-change fingerprint.
  const domain = sipDomain.toLowerCase();
  if (!SIP_DOMAIN_RE.test(domain) || !ACCOUNT_RE.test(account)) {
    return null;
  }
  if (typeof a1Hash !== "string" || !A1_HASH.test(a1Hash)) {
    return null;
  }
  const expiresAtMs = parseExpiresAt(expiresAt);
  if (expiresAtMs === null) {
    return null;
  }
  // Rebuilt field by field: whatever else the page attached (the envelope keys, extra keys,
  // a hostile __proto__) is left behind rather than carried into the extension.
  return { sipDomain: domain, wssUrl, account, a1Hash, expiresAt: expiresAtMs };
}

/** Strict parse of a page → extension message. Returns null for anything malformed. */
export function parsePageMessage(data: unknown): PageInbound | null {
  if (!isRecord(data)) {
    return null;
  }
  if (data.source !== PAGE_SOURCE || data.protocolVersion !== PROTOCOL_VERSION) {
    return null;
  }
  switch (data.type) {
    case "hello":
      return nonEmptyString(data.nonce) ? { type: "hello", nonce: data.nonce } : null;
    case "provision": {
      if (!nonEmptyString(data.nonce)) {
        return null;
      }
      // The credential fields ride flat on the message itself, not in a nested object.
      const credential = parseProvisionRequest(data);
      return credential ? { type: "provision", nonce: data.nonce, credential } : null;
    }
    case "deprovision":
      return { type: "deprovision" };
    default:
      return null;
  }
}

const ERROR_TO_PAGE: Record<NonNullable<DisplayState["error"]>, PageError> = {
  MICROPHONE_BLOCKED: "MIC_UNAVAILABLE",
  CONNECTION_LOST: "WSS_LOST",
  REGISTRATION_FAILED: "REGISTRATION_FAILED",
  MEDIA_FAILED: "MEDIA_FAILED"
};

const MIC_TO_PAGE: Record<DisplayState["link"]["microphone"], PageMicrophone> = {
  ok: "GRANTED",
  blocked: "DENIED",
  unknown: "UNKNOWN"
};

function pageRegistration(state: DisplayState): PageRegistration {
  switch (state.link.registration) {
    case "up":
      return "REGISTERED";
    case "connecting":
      return "REGISTERING";
    default:
      return state.error === "REGISTRATION_FAILED" ? "FAILED" : "UNREGISTERED";
  }
}

/**
 * Map internal display state to the page-facing state. Built key by key from a fixed set, so
 * a credential that leaks into `details` can never ride out to the page.
 */
export function toPageState(state: DisplayState): PageState {
  return {
    source: EXTENSION_SOURCE,
    protocolVersion: PROTOCOL_VERSION,
    type: "state",
    registration: pageRegistration(state),
    account: state.details.account,
    sipDomain: state.details.domain,
    credentialSource: state.details.credentialSource,
    provisionStatus: state.details.provisionStatus,
    microphone: MIC_TO_PAGE[state.link.microphone],
    error: state.error === null ? null : ERROR_TO_PAGE[state.error]
  };
}
