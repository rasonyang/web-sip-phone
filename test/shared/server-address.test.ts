import { describe, expect, it } from "vitest";
import { isPrivateNetworkHost, parseServerAddress, serverWarningText } from "../../src/shared/server-address.js";

function ok(input: string) {
  const parsed = parseServerAddress(input);
  if (!parsed.ok) {
    throw new Error(`expected ${input} to parse, got: ${parsed.error}`);
  }
  return parsed;
}

function err(input: string): string {
  const parsed = parseServerAddress(input);
  if (parsed.ok) {
    throw new Error(`expected ${input} to be rejected, got: ${parsed.serverUrl}`);
  }
  return parsed.error;
}

describe("parseServerAddress", () => {
  it("defaults a bare hostname to wss://", () => {
    expect(ok("voice.example.com")).toEqual({
      ok: true,
      serverUrl: "wss://voice.example.com/",
      domain: "voice.example.com",
      plaintext: false
    });
  });

  it("keeps a port", () => {
    expect(ok("voice.example.com:7443").serverUrl).toBe("wss://voice.example.com:7443/");
  });

  it("keeps a path", () => {
    expect(ok("wss://voice.example.com/ws").serverUrl).toBe("wss://voice.example.com/ws");
    expect(ok("voice.example.com:7443/ws").serverUrl).toBe("wss://voice.example.com:7443/ws");
  });

  it("strips a sip: / sips: prefix", () => {
    expect(ok("sip:voice.example.com").serverUrl).toBe("wss://voice.example.com/");
    expect(ok("SIPS:voice.example.com").serverUrl).toBe("wss://voice.example.com/");
    expect(ok(" sip: voice.example.com ").serverUrl).toBe("wss://voice.example.com/");
  });

  it("normalizes https to wss", () => {
    expect(ok("https://voice.example.com")).toEqual({
      ok: true,
      serverUrl: "wss://voice.example.com/",
      domain: "voice.example.com",
      plaintext: false
    });
  });

  it("lowercases the scheme and host", () => {
    expect(ok("WSS://Voice.Example.COM")).toEqual({
      ok: true,
      serverUrl: "wss://voice.example.com/",
      domain: "voice.example.com",
      plaintext: false
    });
  });

  it("rejects ws:// on a public host", () => {
    expect(err("ws://voice.example.com")).toBe("ws:// is only allowed for private-network or local addresses.");
    expect(err("ws://8.8.8.8")).toBe("ws:// is only allowed for private-network or local addresses.");
    expect(err("http://voice.example.com")).toBe("ws:// is only allowed for private-network or local addresses.");
  });

  it("allows ws:// on private-network and local addresses", () => {
    expect(ok("ws://192.168.1.10:5066/sip")).toEqual({
      ok: true,
      serverUrl: "ws://192.168.1.10:5066/sip",
      domain: "192.168.1.10",
      plaintext: true
    });
    expect(ok("http://localhost:5066")).toEqual({
      ok: true,
      serverUrl: "ws://localhost:5066/",
      domain: "localhost",
      plaintext: true
    });
    expect(ok("ws://10.0.0.1/").plaintext).toBe(true);
    expect(ok("ws://169.254.1.1").plaintext).toBe(true);
  });

  it("allows private IPv6 and reports the domain without brackets", () => {
    expect(ok("ws://[::1]:5066")).toEqual({
      ok: true,
      serverUrl: "ws://[::1]:5066/",
      domain: "::1",
      plaintext: true
    });
    expect(ok("ws://[fd00::1]")).toEqual({
      ok: true,
      serverUrl: "ws://[fd00::1]/",
      domain: "fd00::1",
      plaintext: true
    });
  });

  it("rejects an empty or blank value", () => {
    expect(err("")).toBe("Enter the server address.");
    expect(err("   ")).toBe("Enter the server address.");
    expect(err("sip:")).toBe("Enter the server address.");
  });

  it("rejects an unsupported scheme", () => {
    expect(err("ftp://x")).toBe("Unsupported scheme ftp://.");
    expect(err("file://x/y")).toBe("Unsupported scheme file://.");
  });

  it("rejects an unparseable address", () => {
    expect(err("wss://")).toBe("Enter a valid server address, for example voice.example.com.");
    expect(err("not a host")).toBe("Enter a valid server address, for example voice.example.com.");
  });
});

describe("isPrivateNetworkHost", () => {
  it("accepts local names and their suffixes", () => {
    expect(isPrivateNetworkHost("localhost")).toBe(true);
    expect(isPrivateNetworkHost("app.localhost")).toBe(true);
    expect(isPrivateNetworkHost("pbx.local")).toBe(true);
    expect(isPrivateNetworkHost("pbx.home.arpa")).toBe(true);
    expect(isPrivateNetworkHost("PBX.Local")).toBe(true);
  });
  it("accepts the private IPv4 ranges", () => {
    expect(isPrivateNetworkHost("127.0.0.1")).toBe(true);
    expect(isPrivateNetworkHost("10.1.2.3")).toBe(true);
    expect(isPrivateNetworkHost("172.16.0.1")).toBe(true);
    expect(isPrivateNetworkHost("172.31.255.255")).toBe(true);
    expect(isPrivateNetworkHost("192.168.31.55")).toBe(true);
    expect(isPrivateNetworkHost("169.254.1.1")).toBe(true);
  });
  it("accepts ::1 and fc00::/7, bracketed or not", () => {
    expect(isPrivateNetworkHost("::1")).toBe(true);
    expect(isPrivateNetworkHost("[::1]")).toBe(true);
    expect(isPrivateNetworkHost("fd00::1")).toBe(true);
    expect(isPrivateNetworkHost("[fc00::1]")).toBe(true);
  });
  it("rejects public hosts and near misses", () => {
    expect(isPrivateNetworkHost("voice.example.com")).toBe(false);
    expect(isPrivateNetworkHost("evillocalhost")).toBe(false);
    expect(isPrivateNetworkHost("8.8.8.8")).toBe(false);
    expect(isPrivateNetworkHost("172.32.0.1")).toBe(false);
    expect(isPrivateNetworkHost("169.253.1.1")).toBe(false);
    expect(isPrivateNetworkHost("2001:db8::1")).toBe(false);
    expect(isPrivateNetworkHost("")).toBe(false);
  });
});

describe("serverWarningText", () => {
  const PLAINTEXT = "Signaling and credentials are sent in plaintext. Use only on a trusted network.";
  const MIXED =
    " Browsers block ws:// connections from an https page as mixed content (localhost and 127.0.0.1 excepted).";

  it("says nothing for wss or for a rejected address", () => {
    expect(serverWarningText(parseServerAddress("voice.example.com"), "https:")).toBeNull();
    expect(serverWarningText(parseServerAddress("ws://voice.example.com"), "https:")).toBeNull();
  });

  it("warns about plaintext on an extension page", () => {
    expect(serverWarningText(parseServerAddress("ws://192.168.1.10:5066"), "chrome-extension:")).toBe(PLAINTEXT);
  });

  it("adds the mixed-content sentence on an https page", () => {
    expect(serverWarningText(parseServerAddress("ws://192.168.1.10:5066"), "https:")).toBe(PLAINTEXT + MIXED);
  });

  it("omits the mixed-content sentence for the exempt local hosts", () => {
    expect(serverWarningText(parseServerAddress("ws://localhost:5066"), "https:")).toBe(PLAINTEXT);
    expect(serverWarningText(parseServerAddress("ws://127.0.0.1:5066"), "https:")).toBe(PLAINTEXT);
    expect(serverWarningText(parseServerAddress("ws://[::1]:5066"), "https:")).toBe(PLAINTEXT);
  });
});
