import { describe, expect, it } from "vitest";
import { RuntimeState, IDLE_LINK } from "../../src/shared/state.js";
import type { OffscreenStatus } from "../../src/shared/messages.js";
import { computeDisplayState } from "../../src/background/state-aggregator.js";

const base: OffscreenStatus = {
  phase: "ready",
  errors: [],
  reconnecting: false,
  link: IDLE_LINK,
  callInProgress: false,
  registrationExpiresAt: null,
  reconnect: null,
  micDeviceLabel: null,
  micLevel: null,
  lastError: null
};

const IDENTITY = { account: "1001", domain: "voice.example.com", turnConfigured: false };

describe("computeDisplayState", () => {
  it("UNCONFIGURED when account incomplete", () => {
    expect(computeDisplayState({ configured: false, allowTabCount: 3, offscreen: base }).runtime).toBe(
      RuntimeState.Unconfigured
    );
  });
  it("INACTIVE_NO_ALLOWED_SITE when no allow-site tab", () => {
    expect(computeDisplayState({ configured: true, allowTabCount: 0, offscreen: null }).runtime).toBe(
      RuntimeState.InactiveNoAllowedSite
    );
  });
  it("CONNECTING while offscreen not yet reporting", () => {
    expect(computeDisplayState({ configured: true, allowTabCount: 1, offscreen: null }).runtime).toBe(
      RuntimeState.Connecting
    );
  });
  it("maps phases", () => {
    expect(
      computeDisplayState({ configured: true, allowTabCount: 1, offscreen: { ...base, phase: "registering" } }).runtime
    ).toBe(RuntimeState.Registering);
    expect(computeDisplayState({ configured: true, allowTabCount: 1, offscreen: base }).runtime).toBe(RuntimeState.Ready);
  });
  it("prioritized error wins over phase and carries the error slot", () => {
    const s = computeDisplayState({
      configured: true,
      allowTabCount: 1,
      offscreen: { ...base, errors: ["CONNECTION_LOST", "MICROPHONE_BLOCKED"] }
    });
    expect(s.runtime).toBe(RuntimeState.MicrophoneBlocked);
    expect(s.error).toBe("MICROPHONE_BLOCKED");
  });
  it("merges config identity with live runtime detail, and never a password", () => {
    const s = computeDisplayState({
      configured: true,
      allowTabCount: 1,
      identity: { ...IDENTITY, turnConfigured: true },
      offscreen: {
        ...base,
        registrationExpiresAt: 1_770_000_600_000,
        reconnect: { attempt: 2, nextAttemptAt: 1_770_000_010_000 },
        micDeviceLabel: "Studio Mic",
        micLevel: 0.4,
        lastError: { code: "REGISTRATION_FAILED", reasonPhrase: "403 Forbidden" }
      }
    });
    expect(s.details).toEqual({
      account: "1001",
      domain: "voice.example.com",
      turnConfigured: true,
      registrationExpiresAt: 1_770_000_600_000,
      reconnect: { attempt: 2, nextAttemptAt: 1_770_000_010_000 },
      micDeviceLabel: "Studio Mic",
      micLevel: 0.4,
      lastError: { code: "REGISTRATION_FAILED", reasonPhrase: "403 Forbidden" }
    });
    expect(JSON.stringify(s)).not.toContain("password");
  });

  it("still carries identity when the runtime is not running at all", () => {
    const s = computeDisplayState({ configured: true, allowTabCount: 0, identity: IDENTITY, offscreen: null });
    expect(s.runtime).toBe(RuntimeState.InactiveNoAllowedSite);
    expect(s.details.account).toBe("1001");
    expect(s.details.micLevel).toBeNull();
  });

  it("no error → error slot null, reconnecting passed through", () => {
    const s = computeDisplayState({ configured: true, allowTabCount: 1, offscreen: { ...base, reconnecting: true } });
    expect(s.error).toBeNull();
    expect(s.reconnecting).toBe(true);
  });
});
