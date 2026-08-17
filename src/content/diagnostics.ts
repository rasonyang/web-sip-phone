import { RuntimeState, type DisplayState } from "../shared/state.js";

/** mm:ss for a duration, clamped at zero ("0:00" once a deadline has passed). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Support-paste diagnostics: everything a person debugging a voice link asks for, and nothing
 * that must not leave the extension. The SIP password is never in the content script's reach
 * (it lives in the service worker's config and the offscreen document's UA), and the closing
 * line says so explicitly rather than leaving the reader to wonder what was withheld.
 */
export function buildDiagnostics(state: DisplayState, version: string, now: number): string {
  const d = state.details;
  const lines = [
    `Web SIP Phone ${version} — diagnostics`,
    `Generated: ${iso(now)}`,
    `Extension: ${d.account ?? "(not configured)"}${d.domain ? ` @ ${d.domain}` : ""}`,
    `Runtime state: ${state.runtime}`,
    `Reconnecting: ${state.reconnecting ? "yes" : "no"}`,
    `On a call: ${state.busy ? "yes" : "no"}`,
    `SIP registration: ${state.link.registration}`,
    `WebSocket: ${state.link.websocket}`,
    `Microphone: ${state.link.microphone}${d.micDeviceLabel ? ` (${d.micDeviceLabel})` : ""}`,
    `Media: ${state.link.media}`,
    `TURN: ${d.turnConfigured ? "configured" : "not configured"}`
  ];
  if (d.registrationExpiresAt !== null) {
    lines.push(`Registration expires: ${iso(d.registrationExpiresAt)} (in ${formatDuration(d.registrationExpiresAt - now)})`);
  }
  if (d.reconnect) {
    lines.push(`Next attempt: #${d.reconnect.attempt} at ${iso(d.reconnect.nextAttemptAt)}`);
  }
  lines.push(
    d.lastError
      ? `Last error: ${d.lastError.code}${d.lastError.reasonPhrase ? ` — ${d.lastError.reasonPhrase}` : ""}`
      : "Last error: none"
  );
  if (state.runtime === RuntimeState.Unconfigured) {
    lines.push("Note: no SIP account is configured.");
  }
  lines.push("Credentials: not included — the SIP password never leaves Settings.");
  return lines.join("\n");
}
