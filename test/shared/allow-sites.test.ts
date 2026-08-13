import { describe, expect, it } from "vitest";
import { normalizeHostname, originPatterns, urlMatchesAllowSite } from "../../src/shared/allow-sites.js";

describe("normalizeHostname", () => {
  it("lowercases and trims", () => {
    expect(normalizeHostname("  CRM.Example.com ")).toBe("crm.example.com");
  });
  it("rejects scheme, port, path, wildcard, empty", () => {
    expect(normalizeHostname("https://crm.example.com")).toBeNull();
    expect(normalizeHostname("crm.example.com:8443")).toBeNull();
    expect(normalizeHostname("crm.example.com/path")).toBeNull();
    expect(normalizeHostname("*.example.com")).toBeNull();
    expect(normalizeHostname("")).toBeNull();
    expect(normalizeHostname("not a host")).toBeNull();
  });
});

describe("urlMatchesAllowSite", () => {
  const sites = ["crm.example.com", "desk.example.org"];
  it("matches exact hostname over https", () => {
    expect(urlMatchesAllowSite("https://crm.example.com/tickets?id=1", sites)).toBe(true);
    expect(urlMatchesAllowSite("https://desk.example.org/", sites)).toBe(true);
  });
  it("does not match subdomains or similar domains", () => {
    expect(urlMatchesAllowSite("https://sub.crm.example.com/", sites)).toBe(false);
    expect(urlMatchesAllowSite("https://www.crm.example.com/", sites)).toBe(false);
    expect(urlMatchesAllowSite("https://example.com/", sites)).toBe(false);
    expect(urlMatchesAllowSite("https://crm.example.com.evil.io/", sites)).toBe(false);
  });
  it("rejects non-https and invalid URLs", () => {
    expect(urlMatchesAllowSite("http://crm.example.com/", sites)).toBe(false);
    expect(urlMatchesAllowSite("chrome://extensions", sites)).toBe(false);
    expect(urlMatchesAllowSite("not-a-url", sites)).toBe(false);
  });
});

describe("originPattern", () => {
  it("builds the https match pattern", () => {
    expect(originPatterns("crm.example.com")).toEqual(["https://crm.example.com/*"]);
  });
  it("loopback hosts get both schemes (match patterns cannot carry a port)", () => {
    expect(originPatterns("127.0.0.1")).toEqual(["http://127.0.0.1/*", "https://127.0.0.1/*"]);
    expect(originPatterns("localhost")).toEqual(["http://localhost/*", "https://localhost/*"]);
  });
});

describe("loopback development exception", () => {
  it("accepts loopback hosts and strips a pasted port", () => {
    expect(normalizeHostname("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeHostname("localhost")).toBe("localhost");
    expect(normalizeHostname("127.0.0.1:8080")).toBe("127.0.0.1");
    expect(normalizeHostname("LocalHost:3000")).toBe("localhost");
  });
  it("still rejects ports on non-loopback hosts", () => {
    expect(normalizeHostname("crm.example.com:8443")).toBeNull();
  });
  it("matches http loopback URLs on any port, but never http on real hosts", () => {
    const sites = ["127.0.0.1", "localhost", "crm.example.com"];
    expect(urlMatchesAllowSite("http://127.0.0.1:8080/app", sites)).toBe(true);
    expect(urlMatchesAllowSite("http://localhost:3000/", sites)).toBe(true);
    expect(urlMatchesAllowSite("https://localhost/", sites)).toBe(true);
    expect(urlMatchesAllowSite("http://crm.example.com/", sites)).toBe(false);
  });
});
