import { describe, expect, it } from "vitest";
import { isPrivateHost, normalizeHostname, originPatterns, urlMatchesAllowSite } from "../../src/shared/allow-sites.js";

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
    expect(originPatterns("8.8.8.8")).toEqual(["https://8.8.8.8/*"]);
    expect(originPatterns("172.32.0.1")).toEqual(["https://172.32.0.1/*"]);
  });
  it("private hosts get both schemes (match patterns cannot carry a port)", () => {
    expect(originPatterns("127.0.0.1")).toEqual(["http://127.0.0.1/*", "https://127.0.0.1/*"]);
    expect(originPatterns("localhost")).toEqual(["http://localhost/*", "https://localhost/*"]);
    expect(originPatterns("app.localhost")).toEqual(["http://app.localhost/*", "https://app.localhost/*"]);
    expect(originPatterns("192.168.31.55")).toEqual(["http://192.168.31.55/*", "https://192.168.31.55/*"]);
    expect(originPatterns("10.0.0.1")).toEqual(["http://10.0.0.1/*", "https://10.0.0.1/*"]);
  });
});

describe("isPrivateHost", () => {
  it("accepts localhost and .localhost names", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("app.localhost")).toBe(true);
    expect(isPrivateHost("a.b.localhost")).toBe(true);
  });
  it("accepts the private IPv4 ranges", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("127.0.0.2")).toBe(true);
    expect(isPrivateHost("127.255.255.255")).toBe(true);
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("10.255.255.255")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("192.168.0.1")).toBe(true);
    expect(isPrivateHost("192.168.31.55")).toBe(true);
    expect(isPrivateHost("192.168.255.255")).toBe(true);
  });
  it("rejects addresses just outside the private ranges", () => {
    expect(isPrivateHost("172.15.0.1")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
    expect(isPrivateHost("192.169.0.1")).toBe(false);
    expect(isPrivateHost("192.167.0.1")).toBe(false);
    expect(isPrivateHost("11.0.0.1")).toBe(false);
    expect(isPrivateHost("9.255.255.255")).toBe(false);
    expect(isPrivateHost("126.0.0.1")).toBe(false);
    expect(isPrivateHost("128.0.0.1")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
  });
  it("rejects hostnames that merely end in the word localhost", () => {
    expect(isPrivateHost("evillocalhost")).toBe(false);
    expect(isPrivateHost("notlocalhost")).toBe(false);
    expect(isPrivateHost("localhost.evil.io")).toBe(false);
    expect(isPrivateHost("crm.example.com")).toBe(false);
  });
  it("does not mistake malformed addresses for private ones", () => {
    expect(isPrivateHost("192.1680.1.1")).toBe(false);
    expect(isPrivateHost("192.168.1")).toBe(false);
    expect(isPrivateHost("192.168.1.256")).toBe(false);
    expect(isPrivateHost("192.168.1.1.1")).toBe(false);
    expect(isPrivateHost("192.168.01.1")).toBe(false);
    expect(isPrivateHost("192.168.1.a")).toBe(false);
    expect(isPrivateHost("192.168..1")).toBe(false);
    expect(isPrivateHost("010.0.0.1")).toBe(false);
  });
});

describe("private-network development exception", () => {
  it("accepts private hosts and strips a pasted port", () => {
    expect(normalizeHostname("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeHostname("localhost")).toBe("localhost");
    expect(normalizeHostname("127.0.0.1:8080")).toBe("127.0.0.1");
    expect(normalizeHostname("LocalHost:3000")).toBe("localhost");
    expect(normalizeHostname("192.168.31.55")).toBe("192.168.31.55");
    expect(normalizeHostname("192.168.31.55:8080")).toBe("192.168.31.55");
    expect(normalizeHostname("10.0.0.1:5066")).toBe("10.0.0.1");
    expect(normalizeHostname("172.16.0.1:443")).toBe("172.16.0.1");
    expect(normalizeHostname("App.Localhost:8100")).toBe("app.localhost");
  });
  it("still rejects ports on public hosts", () => {
    expect(normalizeHostname("crm.example.com:8443")).toBeNull();
    expect(normalizeHostname("8.8.8.8:8080")).toBeNull();
    expect(normalizeHostname("172.32.0.1:8080")).toBeNull();
    expect(normalizeHostname("192.169.0.1:8080")).toBeNull();
  });
  it("matches http private URLs on any port, but never http on public hosts", () => {
    const sites = [
      "127.0.0.1",
      "127.0.0.2",
      "localhost",
      "app.localhost",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.31.55",
      "172.15.0.1",
      "172.32.0.1",
      "192.169.0.1",
      "11.0.0.1",
      "8.8.8.8",
      "evillocalhost",
      "notlocalhost",
      "crm.example.com",
    ];
    expect(urlMatchesAllowSite("http://127.0.0.1:8080/app", sites)).toBe(true);
    expect(urlMatchesAllowSite("http://127.0.0.2/", sites)).toBe(true);
    expect(urlMatchesAllowSite("http://localhost:3000/", sites)).toBe(true);
    expect(urlMatchesAllowSite("http://app.localhost:8100/", sites)).toBe(true);
    expect(urlMatchesAllowSite("https://localhost/", sites)).toBe(true);
    expect(urlMatchesAllowSite("http://192.168.31.55:8080/app", sites)).toBe(true);
    expect(urlMatchesAllowSite("http://192.168.31.55/", sites)).toBe(true);
    expect(urlMatchesAllowSite("http://10.0.0.1/", sites)).toBe(true);
    expect(urlMatchesAllowSite("http://172.16.0.1/", sites)).toBe(true);
    expect(urlMatchesAllowSite("http://172.31.255.255/", sites)).toBe(true);

    expect(urlMatchesAllowSite("http://8.8.8.8/", sites)).toBe(false);
    expect(urlMatchesAllowSite("http://172.15.0.1/", sites)).toBe(false);
    expect(urlMatchesAllowSite("http://172.32.0.1/", sites)).toBe(false);
    expect(urlMatchesAllowSite("http://192.169.0.1/", sites)).toBe(false);
    expect(urlMatchesAllowSite("http://11.0.0.1/", sites)).toBe(false);
    expect(urlMatchesAllowSite("http://evillocalhost/", sites)).toBe(false);
    expect(urlMatchesAllowSite("http://notlocalhost/", sites)).toBe(false);
    expect(urlMatchesAllowSite("http://crm.example.com/", sites)).toBe(false);

    expect(urlMatchesAllowSite("https://8.8.8.8/", sites)).toBe(true);
    expect(urlMatchesAllowSite("https://172.32.0.1/", sites)).toBe(true);
  });
});
