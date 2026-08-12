import { describe, expect, it } from "vitest";
import { RuntimeState, IDLE_LINK } from "../../src/shared/state.js";
import type { OffscreenStatus } from "../../src/shared/messages.js";
import { computeDisplayState } from "../../src/background/state-aggregator.js";

const base: OffscreenStatus = { phase: "ready", errors: [], reconnecting: false, link: IDLE_LINK, callInProgress: false };

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
  it("no error → error slot null, reconnecting passed through", () => {
    const s = computeDisplayState({ configured: true, allowTabCount: 1, offscreen: { ...base, reconnecting: true } });
    expect(s.error).toBeNull();
    expect(s.reconnecting).toBe(true);
  });
});
