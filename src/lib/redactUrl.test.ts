/**
 * Unit tests for URL redaction — the guard between a user-supplied endpoint and
 * anything that leaves the server.
 *
 * `LH_ANALYSIS_BASE_URL` is pasted by the user and can legally carry a secret
 * two ways: `https://user:pass@host` and a vendor's `?key=…`. It is then quoted
 * in settings responses, SSE error frames, and persisted warnings, so these
 * tests pin that neither form survives the trip.
 */

import { describe, expect, it } from "vitest";

import { redactUrl, redactUrlsInText } from "@/lib/redactUrl";

describe("redactUrl", () => {
  it("strips userinfo", () => {
    expect(redactUrl("https://someone:hunter2@api.example.com/v1")).toBe(
      "https://api.example.com/v1",
    );
  });

  it("strips a query string, where vendors hide keys", () => {
    expect(redactUrl("https://api.example.com/v1?key=abc123&mode=fast")).toBe(
      "https://api.example.com/v1",
    );
  });

  it("strips a fragment", () => {
    expect(redactUrl("https://api.example.com/v1#token")).toBe(
      "https://api.example.com/v1",
    );
  });

  it("keeps the parts that are useful to show", () => {
    expect(redactUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
  });

  it("returns null rather than echoing something it could not parse", () => {
    // "Unparseable" must never degrade to "assume it's clean".
    expect(redactUrl("not a url")).toBeNull();
    expect(redactUrl(null)).toBeNull();
    expect(redactUrl(undefined)).toBeNull();
    expect(redactUrl("")).toBeNull();
  });
});

describe("redactUrlsInText", () => {
  it("cleans a URL quoted inside an SDK error message", () => {
    const message = redactUrlsInText(
      "fetch failed: POST https://someone:hunter2@api.example.com/v1/chat/completions",
    );

    expect(message).toBe(
      "fetch failed: POST https://api.example.com/v1/chat/completions",
    );
    expect(message).not.toContain("hunter2");
  });

  it("cleans a key carried in the query string", () => {
    expect(redactUrlsInText("Cannot reach https://api.example.com/v1?key=abc123.")).toBe(
      "Cannot reach https://api.example.com/v1.",
    );
  });

  it("leaves sentence punctuation outside the URL", () => {
    expect(redactUrlsInText("Tried https://api.example.com/v1, then gave up.")).toBe(
      "Tried https://api.example.com/v1, then gave up.",
    );
  });

  it("handles several URLs in one message", () => {
    const message = redactUrlsInText(
      "https://a:b@one.example.com/x failed, https://c:d@two.example.com/y too",
    );

    expect(message).not.toContain("a:b@");
    expect(message).not.toContain("c:d@");
  });

  it("redacts a bare credential param that is not part of a parseable URL", () => {
    expect(redactUrlsInText("request failed (?api-key=abc123)")).toBe(
      "request failed (?api-key=[redacted])",
    );
    expect(redactUrlsInText("...&token=xyz789 rejected")).toBe(
      "...&token=[redacted] rejected",
    );
  });

  it("leaves text with no URL untouched", () => {
    expect(redactUrlsInText("Model not found.")).toBe("Model not found.");
  });
});
