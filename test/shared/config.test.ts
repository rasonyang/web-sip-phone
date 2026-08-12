import { describe, expect, it } from "vitest";
import { DEFAULT_STUN, deriveEndpoints, iceServers, isAccountComplete } from "../../src/shared/config.js";

describe("deriveEndpoints", () => {
  it("derives SIP URI and WSS URL from hostname + account", () => {
    expect(deriveEndpoints({ domain: "voice.example.com", username: "1001", password: "x" })).toEqual({
      sipUri: "sip:1001@voice.example.com",
      wssUrl: "wss://voice.example.com/"
    });
  });
});

describe("isAccountComplete", () => {
  it("requires all three fields", () => {
    expect(isAccountComplete(null)).toBe(false);
    expect(isAccountComplete({ domain: "d", username: "", password: "p" })).toBe(false);
    expect(isAccountComplete({ domain: "", username: "u", password: "p" })).toBe(false);
    expect(isAccountComplete({ domain: "d", username: "u", password: "" })).toBe(false);
    expect(isAccountComplete({ domain: "d", username: "u", password: "p" })).toBe(true);
  });
});

describe("iceServers", () => {
  it("returns Google STUN by default", () => {
    expect(iceServers(null)).toEqual([{ urls: DEFAULT_STUN }]);
  });
  it("appends TURN only when enabled", () => {
    const turn = { enabled: true, url: "turn:turn.example.com:3478", username: "u", credential: "c" };
    expect(iceServers(turn)).toEqual([
      { urls: DEFAULT_STUN },
      { urls: "turn:turn.example.com:3478", username: "u", credential: "c" }
    ]);
    expect(iceServers({ ...turn, enabled: false })).toEqual([{ urls: DEFAULT_STUN }]);
  });
  it("returns STUN only when enabled but url is empty", () => {
    expect(iceServers({ enabled: true, url: "", username: "", credential: "" })).toEqual([{ urls: DEFAULT_STUN }]);
  });
});
