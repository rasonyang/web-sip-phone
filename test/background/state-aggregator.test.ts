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

const IDENTITY = { account: "1001", domain: "voice.example.com", serverUrl: "wss://voice.example.com/", turnConfigured: false };

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
  it("reports the live call, not INACTIVE_NO_ALLOWED_SITE, when a call outlives the last tab", () => {
    // The lifetime rule keeps the runtime alive with no Allow Site tab while a call is in
    // progress; the Options page is the only surface left, and it must not be told "inactive".
    const s = computeDisplayState({
      configured: true,
      allowTabCount: 0,
      offscreen: { ...base, callInProgress: true }
    });
    expect(s.runtime).toBe(RuntimeState.Ready);
    expect(s.busy).toBe(true);
  });
  it("reports the live call, not UNCONFIGURED, when the credential is dropped mid-call", () => {
    // A provisioned-only credential is dropped the moment its last Allow Site tab closes, so
    // `configured` can go false while the runtime is still carrying the call it must not drop.
    const s = computeDisplayState({
      configured: false,
      allowTabCount: 0,
      offscreen: { ...base, callInProgress: true }
    });
    expect(s.busy).toBe(true);
    expect(s.runtime).not.toBe(RuntimeState.Unconfigured);
    expect(s.runtime).toBe(RuntimeState.Ready);
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
      serverUrl: "wss://voice.example.com/",
      turnConfigured: true,
      registrationExpiresAt: 1_770_000_600_000,
      reconnect: { attempt: 2, nextAttemptAt: 1_770_000_010_000 },
      micDeviceLabel: "Studio Mic",
      micLevel: 0.4,
      lastError: { code: "REGISTRATION_FAILED", reasonPhrase: "403 Forbidden" },
      credentialSource: "NONE",
      provisionedBy: null,
      provisionStatus: "NONE",
      provisionedAccount: null,
      provisionedDomain: null,
      provisionLastSyncAt: null,
      provisionFault: null,
      manualOverride: false
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
