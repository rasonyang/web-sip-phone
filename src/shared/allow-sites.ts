// Allow Sites use exact hostname matching: no wildcards, no subdomain inheritance,
// no ports, no paths, HTTPS only.

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function normalizeHostname(input: string): string | null {
  const host = input.trim().toLowerCase();
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
  return parsed.protocol === "https:" && sites.includes(parsed.hostname.toLowerCase());
}

export function originPattern(host: string): string {
  return `https://${host}/*`;
}
