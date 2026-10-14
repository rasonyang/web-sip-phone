// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readWidgetMode } from "../../src/content/page-declaration.js";

function docWith(head: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head>${head}</head><body></body></html>`, "text/html");
}

describe("readWidgetMode", () => {
  it("is always when nothing is declared", () => {
    expect(readWidgetMode(docWith(""))).toBe("always");
    expect(readWidgetMode(docWith('<meta name="viewport" content="widget=page">'))).toBe("always");
  });

  it("is page for widget=page", () => {
    expect(readWidgetMode(docWith('<meta name="web-sip-phone" content="widget=page">'))).toBe("page");
  });

  it("tolerates whitespace and case", () => {
    expect(readWidgetMode(docWith('<meta name="web-sip-phone" content="  WIDGET = Page ">'))).toBe("page");
    expect(readWidgetMode(docWith('<meta name=" Web-Sip-Phone " content="widget=page">'))).toBe("page");
  });

  it.each([
    ["widget=always"],
    ["widget=pages"],
    ["widget=page; foo=bar"],
    ["widget=page foo=bar"],
    ["foo=bar widget=page"],
    ["widget"],
    ["page"],
    [""]
  ])("treats content %j as no declaration", (content) => {
    expect(readWidgetMode(docWith(`<meta name="web-sip-phone" content="${content}">`))).toBe("always");
  });

  it("treats a missing content attribute as no declaration", () => {
    expect(readWidgetMode(docWith('<meta name="web-sip-phone">'))).toBe("always");
  });

  it("lets the first tag decide, in either order", () => {
    const page = '<meta name="web-sip-phone" content="widget=page">';
    const junk = '<meta name="web-sip-phone" content="widget=always">';
    expect(readWidgetMode(docWith(page + junk))).toBe("page");
    expect(readWidgetMode(docWith(junk + page))).toBe("always");
  });
});
