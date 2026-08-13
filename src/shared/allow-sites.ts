// Allow Sites use exact hostname matching: no wildcards, no subdomain inheritance,
// no ports, no paths, HTTPS only — with one development exception: loopback hosts
// (localhost, 127.0.0.1) are also allowed over plain HTTP so local test pages work.
// Chrome match patterns cannot carry a port, so a loopback entry covers every port
// (http://127.0.0.1:8080 matches the 127.0.0.1 entry).

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function normalizeHostname(input: string): string | null {
  let host = input.trim().toLowerCase();
  // Loopback convenience: accept a pasted "127.0.0.1:8080" by dropping the port —
  // matching is port-insensitive anyway. Non-loopback hosts still reject ports.
  const portMatch = /^([^:]+):\d{1,5}$/.exec(host);
  if (portMatch && isLoopbackHost(portMatch[1])) {
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
  const schemeOk = parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopbackHost(host));
  return schemeOk && sites.includes(host);
}

export function originPatterns(host: string): string[] {
  return isLoopbackHost(host) ? [`http://${host}/*`, `https://${host}/*`] : [`https://${host}/*`];
}
