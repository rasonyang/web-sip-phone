import { describe, expect, it } from "vitest";
import { buildDiagnostics, formatDuration } from "../../src/content/diagnostics.js";
import { EMPTY_DETAILS, IDLE_LINK, RuntimeState, type DisplayState } from "../../src/shared/state.js";

const NOW = 1_770_000_000_000;
const PASSWORD = "sup3r-secret-pw";

const HEALTHY: DisplayState = {
  runtime: RuntimeState.Ready,
  error: null,
  reconnecting: false,
  busy: false,
  link: { registration: "up", websocket: "up", microphone: "ok", media: "idle" },
  details: {
    ...EMPTY_DETAILS,
    account: "1001",
    domain: "voice.example.com",
    registrationExpiresAt: NOW + 252_000,
    micDeviceLabel: "Studio Mic",
    turnConfigured: true
  }
};

describe("formatDuration", () => {
  it("renders m:ss and never counts below zero", () => {
    expect(formatDuration(252_000)).toBe("4:12");
    expect(formatDuration(8_000)).toBe("0:08");
    expect(formatDuration(-5_000)).toBe("0:00");
  });
});

describe("buildDiagnostics", () => {
  it("captures identity, every signal, and the expiry", () => {
    const text = buildDiagnostics(HEALTHY, "1.0.2", NOW);
    expect(text).toContain("Web SIP Phone 1.0.2");
    expect(text).toContain("Extension: 1001 @ voice.example.com");
    expect(text).toContain("Runtime state: READY");
    expect(text).toContain("SIP registration: up");
    expect(text).toContain("WebSocket: up");
    expect(text).toContain("Microphone: ok (Studio Mic)");
    expect(text).toContain("Media: idle");
    expect(text).toContain("TURN: configured");
    expect(text).toContain("(in 4:12)");
    expect(text).toContain("Last error: none");
  });

  it("captures the fault, its reason and the pending retry", () => {
    const text = buildDiagnostics(
      {
        ...HEALTHY,
        runtime: RuntimeState.RegistrationFailed,
        error: "REGISTRATION_FAILED",
        link: { ...IDLE_LINK, microphone: "ok" },
        details: {
          ...HEALTHY.details,
          registrationExpiresAt: null,
          reconnect: { attempt: 3, nextAttemptAt: NOW + 12_000 },
          lastError: { code: "REGISTRATION_FAILED", reasonPhrase: "403 Forbidden" }
        }
      },
      "1.0.2",
      NOW
    );
    expect(text).toContain("Last error: REGISTRATION_FAILED — 403 Forbidden");
    expect(text).toContain("Next attempt: #3");
    expect(text).not.toContain("Registration expires:");
  });

  it("never contains a credential — the content script has none to leak", () => {
    // The password is deliberately absent from DisplayState; this asserts the shape stays that way.
    const state = JSON.parse(JSON.stringify(HEALTHY)) as DisplayState;
    const text = buildDiagnostics(state, "1.0.2", NOW);
    expect(text).not.toContain(PASSWORD);
    expect(JSON.stringify(state)).not.toContain(PASSWORD);
    expect(text.toLowerCase()).not.toMatch(/password: \S/);
    expect(text).toContain("Credentials: not included");
  });

  it("says so when nothing is configured yet", () => {
    const text = buildDiagnostics(
      { ...HEALTHY, runtime: RuntimeState.Unconfigured, details: { ...EMPTY_DETAILS } },
      "1.0.2",
      NOW
    );
    expect(text).toContain("Extension: (not configured)");
    expect(text).toContain("no SIP account is configured");
  });
});
