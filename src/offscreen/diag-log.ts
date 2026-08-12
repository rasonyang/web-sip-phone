export interface DiagEntry {
  ts: number;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

const CAPACITY = 200;
const SECRET_KEY_RE = /password|credential|authorization/i;

let entries: DiagEntry[] = [];

const MAX_REDACT_DEPTH = 4;

function sanitize(value: unknown, depth: number): unknown {
  if (depth >= MAX_REDACT_DEPTH) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitize(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Redaction happens at log time so secrets can never enter the buffer (design.md §19). */
export function diag(category: string, message: string, data?: Record<string, unknown>): void {
  const safeData: Record<string, unknown> | undefined = data
    ? (sanitize(data, 0) as Record<string, unknown>)
    : undefined;
  entries.push({ ts: Date.now(), category, message, data: safeData });
  if (entries.length > CAPACITY) {
    entries = entries.slice(entries.length - CAPACITY);
  }
  // Mirror to the console so field issues can be inspected in the offscreen document's
  // DevTools (filter: [WebSipPhone:diag]) without a debugger attached ahead of time.
  console.debug(`[WebSipPhone:diag] ${category}: ${message}`, safeData ?? "");
}

export function getDiagEntries(): ReadonlyArray<DiagEntry> {
  return entries;
}

export function clearDiag(): void {
  entries = [];
}

export function maskNumber(value: string): string {
  if (value.length <= 4) {
    return "***";
  }
  return value.slice(0, 2) + "*".repeat(value.length - 4) + value.slice(-2);
}
