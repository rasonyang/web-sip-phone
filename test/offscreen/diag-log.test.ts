import { beforeEach, describe, expect, it } from "vitest";
import { clearDiag, diag, getDiagEntries, maskNumber } from "../../src/offscreen/diag-log.js";

beforeEach(() => clearDiag());

describe("diag log", () => {
  it("records entries with category and message", () => {
    diag("sip", "REGISTER sent", { callId: "abc" });
    const entries = getDiagEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ category: "sip", message: "REGISTER sent", data: { callId: "abc" } });
  });

  it("redacts secret-bearing keys at log time", () => {
    diag("sip", "auth", {
      password: "hunter2",
      turnCredential: "s3cret",
      authorization: "Digest ...",
      proxyAuthorization: "Digest ...",
      callId: "keep-me"
    });
    const data = getDiagEntries()[0].data!;
    expect(data.password).toBe("[redacted]");
    expect(data.turnCredential).toBe("[redacted]");
    expect(data.authorization).toBe("[redacted]");
    expect(data.proxyAuthorization).toBe("[redacted]");
    expect(data.callId).toBe("keep-me");
  });

  it("redacts secret-bearing keys nested inside objects and arrays", () => {
    diag("sip", "auth", {
      headers: { Authorization: "Digest x", callId: "keep" },
      turn: { credential: "s" },
      list: [{ password: "p" }]
    });
    const data = getDiagEntries()[0].data! as any;
    expect(data.headers.Authorization).toBe("[redacted]");
    expect(data.headers.callId).toBe("keep");
    expect(data.turn.credential).toBe("[redacted]");
    expect(data.list[0].password).toBe("[redacted]");
  });

  it("truncates values nested deeper than the max redact depth", () => {
    diag("sip", "deep", { a: { b: { c: { d: { e: "deep" } } } } });
    const data = getDiagEntries()[0].data! as any;
    expect(data.a.b.c.d).toBe("[truncated]");
  });

  it("caps at 200 entries, dropping oldest", () => {
    for (let i = 0; i < 250; i++) diag("x", `m${i}`);
    const entries = getDiagEntries();
    expect(entries.length).toBe(200);
    expect(entries[0].message).toBe("m50");
    expect(entries[199].message).toBe("m249");
  });
});

describe("maskNumber", () => {
  it("masks middle digits", () => {
    expect(maskNumber("+15551234567")).toBe("+1********67");
  });
  it("fully masks short values", () => {
    expect(maskNumber("123")).toBe("***");
  });
});
