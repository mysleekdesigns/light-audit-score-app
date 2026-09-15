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

import {
  redactCredentialParams,
  redactForExport,
  redactUrl,
  redactUrlsInText,
  safeHttpHref,
} from "@/lib/redactUrl";

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

/**
 * `safeHttpHref` guards the other direction: a URL a MODEL produced, on its way
 * into an `href` the user clicks. Model output is shaped by the audit report,
 * which carries text from the audited page, so a scripting scheme reaching a
 * link would run on the app's own origin inside the gated session.
 */
describe("safeHttpHref", () => {
  it("passes an http(s) URL through unchanged", () => {
    // Unchanged matters: a citation should read as the model wrote it, with no
    // trailing slash or re-encoding introduced by validating it.
    expect(safeHttpHref("https://web.dev/lcp")).toBe("https://web.dev/lcp");
    expect(safeHttpHref("http://localhost:3000/x?a=1#b")).toBe(
      "http://localhost:3000/x?a=1#b",
    );
    expect(safeHttpHref("  https://web.dev/cls  ")).toBe("https://web.dev/cls");
  });

  it("refuses a scripting scheme", () => {
    expect(safeHttpHref("javascript:alert(1)")).toBeNull();
    expect(safeHttpHref("  JavaScript:alert(1)")).toBeNull();
    // The URL parser strips tab/newline exactly as a browser would, so an
    // obfuscated scheme is still recognised as `javascript:` and refused.
    expect(safeHttpHref("java\nscript:alert(1)")).toBeNull();
    expect(safeHttpHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHttpHref("vbscript:msgbox(1)")).toBeNull();
  });

  it("refuses a scheme-relative form the browser would resolve differently", () => {
    // `new URL("http:settings")` with no base yields the absolute
    // `http://settings/` — but the same string in an `href` resolves against the
    // page and navigates into THIS app. Requiring the full `scheme://` closes
    // the gap between what we validate and what the browser will do.
    expect(safeHttpHref("http:settings")).toBeNull();
    expect(safeHttpHref("http:foo/bar")).toBeNull();
    expect(safeHttpHref("http:/example.com")).toBeNull();
    expect(safeHttpHref("//example.com/x")).toBeNull();
  });

  it("refuses a URL carrying userinfo", () => {
    // A real citation never has credentials in it, and `user@host` is the last
    // way a URL can read as one host while resolving to another.
    expect(safeHttpHref("https://web.dev@evil.example/lcp")).toBeNull();
    expect(safeHttpHref("https://user:pass@example.com/x")).toBeNull();
  });

  it("refuses anything that is not an absolute URL", () => {
    expect(safeHttpHref("/api/history")).toBeNull();
    expect(safeHttpHref("web.dev/lcp")).toBeNull();
    expect(safeHttpHref("")).toBeNull();
    expect(safeHttpHref(null)).toBeNull();
    expect(safeHttpHref(undefined)).toBeNull();
  });

  it("refuses a non-web scheme that would still parse", () => {
    expect(safeHttpHref("file:///Users/someone/.env")).toBeNull();
  });
});

/**
 * ROADMAP Phase H: these two exist for the client-report export, where the query
 * string is DATA the waterfall must keep — so the rule is "redact the value of a
 * credential-shaped parameter", not "drop the query" as `redactUrl` does.
 */
describe("redactCredentialParams", () => {
  it("redacts the value but KEEPS the parameter name visible", () => {
    expect(redactCredentialParams("https://x.test/a?token=abc123")).toBe(
      "https://x.test/a?token=[redacted]",
    );
  });

  it("leaves ordinary parameters completely alone", () => {
    const url = "https://cdn.test/app.js?v=4&build=91ab&lang=en-GB";
    expect(redactCredentialParams(url)).toBe(url);
  });

  it("keeps two cache-busted rows distinguishable", () => {
    expect(redactCredentialParams("/app.js?v=3")).not.toBe(
      redactCredentialParams("/app.js?v=4"),
    );
  });

  it("redacts only the credential parameter in a mixed query", () => {
    expect(
      redactCredentialParams("/api/data?page=2&access_token=zzz&sort=asc"),
    ).toBe("/api/data?page=2&access_token=[redacted]&sort=asc");
  });

  it("covers presigned-asset signatures, which is how a sensitive URL usually arrives", () => {
    const signed =
      "https://assets.example.com/k.png?X-Amz-Signature=deadbeef&X-Amz-Expires=900";
    expect(redactCredentialParams(signed)).toContain("X-Amz-Signature=[redacted]");
    // Not a credential — it is metadata, and blanking it would say less truthfully.
    expect(redactCredentialParams(signed)).toContain("X-Amz-Expires=900");
  });

  it("matches case-insensitively and through percent-encoding", () => {
    expect(redactCredentialParams("/a?ToKeN=x")).toBe("/a?ToKeN=[redacted]");
    expect(redactCredentialParams("/a?access%5Ftoken=x")).toBe(
      "/a?access%5Ftoken=[redacted]",
    );
  });

  it("does not fire on a name that merely CONTAINS a credential word", () => {
    const url = "/search?considerations=3&monkey=1&keyboard=x";
    expect(redactCredentialParams(url)).toBe(url);
  });

  it("works on a bare path fragment, which is what a waterfall row carries", () => {
    expect(redactCredentialParams("/p/1?sid=9f3a")).toBe("/p/1?sid=[redacted]");
  });

  it("preserves a fragment and leaves a query-less value untouched", () => {
    expect(redactCredentialParams("/a?token=x#section-2")).toBe(
      "/a?token=[redacted]#section-2",
    );
    expect(redactCredentialParams("/plain/path")).toBe("/plain/path");
    expect(redactCredentialParams("")).toBe("");
  });

  it("does not throw on a malformed percent-escape in a parameter name", () => {
    expect(() => redactCredentialParams("/a?%E0%A4%A=1&token=x")).not.toThrow();
    expect(redactCredentialParams("/a?%E0%A4%A=1&token=x")).toContain(
      "token=[redacted]",
    );
  });
});

describe("redactForExport", () => {
  it("strips user:pass@, which Phase B made a realistic thing to find in an audited URL", () => {
    expect(redactForExport("https://admin:hunter2@staging.test/dashboard")).toBe(
      "https://staging.test/dashboard",
    );
  });

  it("strips userinfo AND credential parameters together", () => {
    const out = redactForExport("https://u:p@x.test/a?token=abc&page=2");
    expect(out).not.toContain("u:p@");
    expect(out).not.toContain("abc");
    expect(out).toContain("token=[redacted]");
    expect(out).toContain("page=2");
  });

  it("passes an unparseable path fragment through the parameter pass rather than dropping it", () => {
    // `redactUrl` returns null here; blanking a legitimate waterfall row would
    // be the wrong trade, so this keeps the row and cleans what it can.
    expect(redactUrl("/p?token=x")).toBeNull();
    expect(redactForExport("/p?token=x")).toBe("/p?token=[redacted]");
  });

  it("leaves an ordinary audited URL byte-for-byte unchanged", () => {
    const url = "https://example.com/products/shoes?colour=red&size=9";
    expect(redactForExport(url)).toBe(url);
  });
});
