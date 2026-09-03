// @ts-nocheck
import { describe, expect, test } from "bun:test";
import { classifyMarkdownLink } from "./markdown-links";

describe("classifyMarkdownLink", () => {
  test("keeps in-document anchors as safe navigation", () => {
    expect(classifyMarkdownLink("#section")).toEqual({ action: "anchor" });
    expect(classifyMarkdownLink("#")).toEqual({ action: "anchor" });
  });

  test("allows only validated http(s) targets, returning the normalized url", () => {
    expect(classifyMarkdownLink("http://example.com/docs")).toEqual({
      action: "open-external",
      url: "http://example.com/docs",
    });
    expect(classifyMarkdownLink("https://example.com/docs#intro")).toEqual({
      action: "open-external",
      url: "https://example.com/docs#intro",
    });
    expect(classifyMarkdownLink("https://example.com/search?q=red+term")).toEqual({
      action: "open-external",
      url: "https://example.com/search?q=red+term",
    });
  });

  test("normalizes scheme and host casing for opener-safe urls", () => {
    const decision = classifyMarkdownLink("HTTPS://EXAMPLE.COM/docs");
    expect(decision.action).toBe("open-external");
    if (decision.action === "open-external") {
      expect(decision.url).toBe("https://example.com/docs");
    }
  });

  test("blocks dangerous schemes and relative navigation", () => {
    expect(classifyMarkdownLink("javascript:alert(1)")).toEqual({ action: "blocked" });
    expect(classifyMarkdownLink("file:///etc/passwd")).toEqual({ action: "blocked" });
    expect(classifyMarkdownLink("data:text/html,<script>")).toEqual({ action: "blocked" });
    expect(classifyMarkdownLink("ftp://example.com/file")).toEqual({ action: "blocked" });
    expect(classifyMarkdownLink("docs/other.md")).toEqual({ action: "blocked" });
    expect(classifyMarkdownLink("../secrets.md")).toEqual({ action: "blocked" });
    expect(classifyMarkdownLink("")).toEqual({ action: "blocked" });
  });
});
