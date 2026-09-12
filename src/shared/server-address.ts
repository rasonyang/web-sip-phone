// One Server field replaces the old Domain + Server URL pair: the user types an address, and
// parsing splits it into the WebSocket transport URL and the bare SIP domain. Bare input defaults
// to `wss://`; plaintext `ws://` (or `http://`) is accepted only for private-network and local
// addresses, where it is a deliberate development choice rather than an accident.

import { parseIpv4 } from "./allow-sites.js";

export type ParsedServer =
  | { ok: true; serverUrl: string; domain: string; plaintext: boolean }
  | { ok: false; error: string };

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const PRIVATE_SUFFIXES = [".localhost", ".local", ".home.arpa"];

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** ::1 and fc00::/7 (unique local). Relies on URL for canonicalization of the compressed form. */
function isPrivateIpv6(host: string): boolean {
  let inner: string;
  try {
    inner = stripBrackets(new URL(`ws://[${host}]/`).hostname);
  } catch {
    return false;
  }
  if (inner === "::1") {
    return true;
  }
  const first = inner.split(":")[0];
  return first.startsWith("fc") || first.startsWith("fd");
}

/**
 * Loopback, link-local and RFC 1918 / RFC 4193 addresses, plus the local-only name suffixes.
 * `hostname` may carry IPv6 brackets or not.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = stripBrackets(hostname.trim().toLowerCase());
  if (!host) {
    return false;
  }
  if (host === "localhost" || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }
  const ip = parseIpv4(host);
  if (ip) {
    const [a, b] = ip;
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
    return false;
  }
  return host.includes(":") ? isPrivateIpv6(host) : false;
}

function fail(error: string): ParsedServer {
  return { ok: false, error };
}

/** Parse what the user typed in the Server field into a transport URL plus the SIP domain. */
export function parseServerAddress(input: string): ParsedServer {
  let text = input.trim();
  // A pasted "sip:voice.example.com" is a SIP URI, not a transport URL; drop the prefix.
  text = text.replace(/^sips?:(?!\/\/)/i, "").trim();
  if (!text) {
    return fail("Enter the server address.");
  }
  if (!SCHEME_RE.test(text)) {
    text = `wss://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail("Enter a valid server address, for example voice.example.com.");
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    return fail("Enter the server address.");
  }
  let protocol: string;
  if (url.protocol === "wss:" || url.protocol === "https:") {
    protocol = "wss:";
  } else if (url.protocol === "ws:" || url.protocol === "http:") {
    if (!isPrivateNetworkHost(hostname)) {
      return fail("ws:// is only allowed for private-network or local addresses.");
    }
    protocol = "ws:";
  } else {
    return fail(`Unsupported scheme ${url.protocol}//.`);
  }
  return {
    ok: true,
    serverUrl: `${protocol}//${url.host.toLowerCase()}${url.pathname}${url.search}`,
    domain: stripBrackets(hostname),
    plaintext: protocol === "ws:"
  };
}

// Mixed content blocking exempts these two (and ::1 in practice), so an https page can still
// reach them over ws://.
const MIXED_CONTENT_EXEMPT = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Inline warning for the Server field, or null when there is nothing to warn about. */
export function serverWarningText(parsed: ParsedServer, pageProtocol: string): string | null {
  if (!parsed.ok || !parsed.plaintext) {
    return null;
  }
  let text = "Signaling and credentials are sent in plaintext. Use only on a trusted network.";
  if (pageProtocol === "https:" && !MIXED_CONTENT_EXEMPT.has(parsed.domain)) {
    text +=
      " Browsers block ws:// connections from an https page as mixed content" +
      " (localhost and 127.0.0.1 excepted).";
  }
  return text;
}
