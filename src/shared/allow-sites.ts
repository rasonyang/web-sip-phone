// Allow Sites use exact hostname matching: no wildcards, no subdomain inheritance,
// no paths, HTTPS only — with one development exception: private-network hosts are
// also allowed over plain HTTP so local and LAN test pages work. A host counts as
// private when it is localhost (or any *.localhost name, RFC 6761) or an IPv4 address
// in 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16.
// Ports never take part in matching — Chrome match patterns cannot carry one — so an
// entry covers every port on that host (https://crm.example.com:8443/x matches the
// crm.example.com entry). A pasted port is therefore stripped from private hosts;
// public hosts still reject an entry that carries one.

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    // Digits only, 1-3 of them, and no leading zero ("0" itself is fine).
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part[0] === "0")) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  return octets;
}

export function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  const ip = parseIpv4(host);
  if (!ip) {
    return false;
  }
  const [a, b] = ip;
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

export function normalizeHostname(input: string): string | null {
  let host = input.trim().toLowerCase();
  // Private-network convenience: accept a pasted "192.168.31.55:8080" by dropping the
  // port — matching is port-insensitive anyway. Public hosts still reject ports.
  const portMatch = /^([^:]+):\d{1,5}$/.exec(host);
  if (portMatch && isPrivateHost(portMatch[1])) {
    host = portMatch[1];
  }
  if (!host || !HOSTNAME_RE.test(host)) {
    return null;
  }
  return host;
}

export function urlMatchesAllowSite(url: string, sites: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const schemeOk = parsed.protocol === "https:" || (parsed.protocol === "http:" && isPrivateHost(host));
  return schemeOk && sites.includes(host);
}

export function originPatterns(host: string): string[] {
  return isPrivateHost(host) ? [`http://${host}/*`, `https://${host}/*`] : [`https://${host}/*`];
}

/** Validation message for the Allow Sites input, naming what is wrong with it; null when it is a valid hostname. */
export function allowSiteInputError(input: string): string | null {
  if (normalizeHostname(input)) {
    return null;
  }
  const text = input.trim();
  if (!text) {
    return "Enter a hostname.";
  }
  // A scheme, port or path all bring a ":" or "/"; a bare hostname has neither.
  if (/[/:]/.test(text)) {
    return "Enter a hostname only — no https://, port, or path";
  }
  return "Enter a valid hostname.";
}
