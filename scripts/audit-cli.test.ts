/**
 * Tests for the audit CLI's pure logic — argument parsing, URL-list parsing, the
 * failure lines and the exit code (ROADMAP Phase F).
 *
 * The flag surface IS the contract a pipeline codes against, so the cases that
 * matter most are the rejections: every one of them must be a `CliUsageError`
 * (→ exit 2, "you invoked me wrong") rather than something that reaches Chrome
 * and fails thirty seconds later as if the site had regressed.
 *
 * Importing the CLI does not run it — `main()` is guarded by an entry-point
 * check — so these exercise the real module, not a copy of it.
 */

import { describe, expect, it } from "vitest";

import { EXIT_FAIL, EXIT_PASS, type CiReport } from "@/lib/ci/types";
import { DEFAULT_DEPTH, DEFAULT_PAGES, MAX_DEPTH } from "@/lib/crawl/types";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "@/lib/queue/types";

import {
  CliUsageError,
  describeViolation,
  displayUrl,
  exitCodeFor,
  normalizeUrl,
  parseCliArgs,
  parseFlags,
  parseUrlList,
  sanitizeMessage,
} from "./audit-cli";

describe("parseFlags", () => {
  it("splits positionals, --key=value, --key value and bare flags", () => {
    const { positionals, flags } = parseFlags([
      "https://example.com",
      "--runs=5",
      "--device",
      "desktop",
      "--accuracy",
    ]);
    expect(positionals).toEqual(["https://example.com"]);
    expect(flags).toEqual({ runs: "5", device: "desktop", accuracy: true });
  });

  it("never lets a boolean flag swallow the URL after it", () => {
    // The pre-Phase-F parser read `--json https://example.com` as
    // `json="https://example.com"` and then reported "no URLs".
    const { positionals, flags } = parseFlags(["--json", "https://example.com"]);
    expect(positionals).toEqual(["https://example.com"]);
    expect(flags.json).toBe(true);
  });
});

describe("normalizeUrl", () => {
  it("adds https:// to a bare host and leaves a full URL alone", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl(" http://127.0.0.1:4317/ ")).toBe("http://127.0.0.1:4317/");
    expect(normalizeUrl("HTTPS://Example.com/a")).toBe("HTTPS://Example.com/a");
  });
});

describe("parseUrlList", () => {
  it("keeps one URL per line, dropping blanks, comments and duplicates", () => {
    const urls = parseUrlList(
      [
        "# a comment",
        "",
        "https://example.com/a",
        "  example.com/b  ",
        "https://example.com/a",
        "   ",
        "#https://example.com/skipped",
      ].join("\n"),
    );
    expect(urls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("preserves a fragment — only a line STARTING with # is a comment", () => {
    expect(parseUrlList("https://example.com/docs#install")).toEqual([
      "https://example.com/docs#install",
    ]);
  });

  it("handles CRLF files", () => {
    expect(parseUrlList("a.com\r\nb.com\r\n")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });
});

describe("parseCliArgs — targets", () => {
  it("normalizes positional URLs and defaults everything else", () => {
    const options = parseCliArgs(["example.com", "https://example.org"]);
    expect(options.urls).toEqual(["https://example.com", "https://example.org"]);
    expect(options.urlsFile).toBeNull();
    expect(options.crawl).toBeNull();
    expect(options.device).toBeNull();
    expect(options.concurrency).toBe(DEFAULT_CONCURRENCY);
    expect(options.accuracyMode).toBe(false);
    expect(options.budget).toBeNull();
    expect(options.reporter).toBeNull();
    expect(options.outputPath).toBeNull();
  });

  it("builds a crawl spec with clamped bounds", () => {
    const options = parseCliArgs([
      "--crawl",
      "example.com",
      "--max-depth=99",
      "--max-pages=10",
      "--no-sitemap",
      "--exclude-paths=/admin, *.pdf",
    ]);
    expect(options.crawl).toEqual({
      url: "https://example.com",
      useSitemap: false,
      useCrawl: true,
      maxDepth: MAX_DEPTH,
      maxPages: 10,
      excludePaths: ["/admin", "*.pdf"],
    });
  });

  it("defaults the crawl bounds when only a seed is given", () => {
    const options = parseCliArgs(["--crawl=example.com"]);
    expect(options.crawl?.maxDepth).toBe(DEFAULT_DEPTH);
    expect(options.crawl?.maxPages).toBe(DEFAULT_PAGES);
    expect(options.crawl?.useSitemap).toBe(true);
    expect(options.crawl?.useCrawl).toBe(true);
  });

  it("rejects a crawl-only dial used without --crawl", () => {
    expect(() => parseCliArgs(["example.com", "--max-pages=10"])).toThrow(
      CliUsageError,
    );
  });
});

describe("parseCliArgs — audit dials", () => {
  it("maps the dials onto the shape resolveAuditOptions validates", () => {
    const options = parseCliArgs([
      "example.com",
      "--runs=5",
      "--throttling=applied",
      "--cpu=2",
      "--categories=performance, seo",
      "--no-warm-cache",
      "--ua=custom-agent",
    ]);
    expect(options.auditOptions).toEqual({
      runs: 5,
      throttling: "applied",
      cpuSlowdownMultiplier: 2,
      categories: ["performance", "seo"],
      warmCache: false,
      emulatedUserAgent: "custom-agent",
    });
  });

  it("keeps --device=both off the audit options (it is a batch fan-out)", () => {
    const both = parseCliArgs(["example.com", "--device=both"]);
    expect(both.device).toBe("both");
    expect(both.auditOptions.formFactor).toBeUndefined();

    const desktop = parseCliArgs(["example.com", "--device=desktop"]);
    expect(desktop.device).toBe("desktop");
    expect(desktop.auditOptions.formFactor).toBe("desktop");
  });

  it("rejects an unknown device rather than passing it to the engine", () => {
    expect(() => parseCliArgs(["--device=tablet"])).toThrow(CliUsageError);
  });

  it("clamps concurrency into the queue's band", () => {
    expect(parseCliArgs(["--concurrency=99"]).concurrency).toBe(MAX_CONCURRENCY);
    expect(parseCliArgs(["--concurrency=1"]).concurrency).toBe(1);
  });

  it("rejects a non-numeric numeric flag", () => {
    expect(() => parseCliArgs(["--runs=lots"])).toThrow(CliUsageError);
  });
});

describe("parseCliArgs — CI flags", () => {
  it("passes --budget through as raw text for resolveBudgets to validate", () => {
    // `0x5a` is 90 to `Number()`; the budget parser rejects it, so the CLI must
    // not quietly convert it here.
    expect(parseCliArgs(["--budget=0x5a"]).budget).toBe("0x5a");
    expect(parseCliArgs(["--budget", "90"]).budget).toBe("90");
  });

  it("accepts every declared reporter and rejects anything else", () => {
    expect(parseCliArgs(["--reporter=json"]).reporter).toBe("json");
    expect(parseCliArgs(["--reporter=jsonExpanded"]).reporter).toBe("jsonExpanded");
    expect(parseCliArgs(["--reporter=csv"]).reporter).toBe("csv");
    expect(parseCliArgs(["--reporter=html"]).reporter).toBe("html");
    expect(() => parseCliArgs(["--reporter=xml"])).toThrow(CliUsageError);
  });

  it("refuses to write two documents to stdout at once", () => {
    expect(() => parseCliArgs(["--json", "--reporter=json"])).toThrow(
      CliUsageError,
    );
  });

  it("refuses --output without a reporter to render into it", () => {
    expect(() => parseCliArgs(["--output=report.json"])).toThrow(CliUsageError);
    expect(
      parseCliArgs(["--reporter=csv", "--output=report.csv"]).outputPath,
    ).toBe("report.csv");
  });

  it("reports a flag given without its value", () => {
    expect(() => parseCliArgs(["--config"])).toThrow(CliUsageError);
  });
});

describe("sanitizeMessage", () => {
  it("flattens control characters so a page cannot repaint a build log", () => {
    expect(sanitizeMessage("boom[2Jwiped\nrest")).toBe("boom [2Jwiped rest");
  });

  it("clamps a runaway message and names the empty case", () => {
    expect(sanitizeMessage("x".repeat(500))).toHaveLength(200);
    expect(sanitizeMessage("")).toBe("unknown error");
    expect(sanitizeMessage(null)).toBe("unknown error");
  });
});

describe("describeViolation", () => {
  const base = {
    url: "https://example.com",
    runId: "run-1",
    formFactor: "mobile",
  } as const;

  it("names the page's shortfall for each reason", () => {
    expect(
      describeViolation(
        { ...base, category: "seo", score: 42, budget: 90, reason: "below" },
        { errorMessage: null },
      ),
    ).toBe("seo 42 < 90");

    expect(
      describeViolation(
        {
          ...base,
          category: "performance",
          score: null,
          budget: 90,
          reason: "unscored",
        },
        { errorMessage: null },
      ),
    ).toBe("performance not scored (budget 90)");

    expect(
      describeViolation(
        {
          ...base,
          category: "performance",
          score: null,
          budget: 90,
          reason: "error",
        },
        { errorMessage: "Chrome\ndied" },
      ),
    ).toBe("performance not measured (budget 90) — Chrome died");
  });
});

describe("exitCodeFor", () => {
  const report = (ok: boolean, errored: number): CiReport =>
    ({
      ok,
      totals: { pages: 1, passed: ok ? 1 : 0, failed: ok ? 0 : 1, errored },
    }) as CiReport;

  it("is exactly `report.ok`, with no second rule of its own", () => {
    expect(exitCodeFor(report(true, 0))).toBe(EXIT_PASS);
    expect(exitCodeFor(report(false, 0))).toBe(EXIT_FAIL);
    // An errored run fails the build — but that rule lives in `evaluateBudgets`,
    // where `ok` is computed, so the JSON and the exit code cannot disagree.
    // `ok: true` alongside `errored: 1` is a state `evaluateBudgets` can no
    // longer produce; if it ever did, trusting `ok` is still the right call
    // here, because the report is what a pipeline reads.
    expect(exitCodeFor(report(false, 1))).toBe(EXIT_FAIL);
  });

  it("does not second-guess a report that says it passed", () => {
    // This used to assert `exitCodeFor(report(true, 1)) === EXIT_FAIL` — the
    // CLI carried its own `errored > 0` rule on top of `ok`. It produced the
    // right exit code by the wrong route: `evaluateBudgets` still said
    // `ok: true`, so anything reading the JSON saw green while the process
    // exited 1. The rule moved to where `ok` is computed; here, `ok` is final.
    expect(exitCodeFor(report(true, 0))).toBe(EXIT_PASS);
  });
});

describe("normalizeUrl — refusals (Phase F security review, H2/M2)", () => {
  it("refuses a URL carrying a username or password", () => {
    // `POST /api/audits` already refuses these because the URL is written
    // verbatim into `runs.url`; the CLI was a second door to the same archive
    // with the check missing — and the worse door, because a CI job publishes
    // the report it writes as a build artifact.
    for (const url of [
      "https://deploy:s3cret@staging.example.com/",
      "https://deploy@staging.example.com/",
      "http://user:pw@example.com/path",
    ]) {
      expect(() => normalizeUrl(url)).toThrow(CliUsageError);
      expect(() => normalizeUrl(url)).toThrow(/username or password/i);
    }
    // And the message points at the mechanism that redacts.
    expect(() => normalizeUrl("https://a:b@c.test/")).toThrow(
      /LH_AUDIT_BASIC_AUTH/,
    );
  });

  it("refuses a non-http(s) scheme and an unparseable target", () => {
    for (const url of ["file:///etc/passwd", "data:text/html,<h1>x", "ftp://x.test/"]) {
      expect(() => normalizeUrl(url)).toThrow(CliUsageError);
    }
    expect(() => normalizeUrl("http://")).toThrow(CliUsageError);
  });

  it("clamps what it echoes back, so a junk target cannot flood a CI log", () => {
    const huge = `https://${"a".repeat(5000)}`;
    try {
      normalizeUrl(`${huge} not a url`);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(200);
    }
  });

  it("returns the string as typed rather than the canonical URL", () => {
    // Canonicalising would file a CLI run and a UI run of the same page under
    // two different `runs.url` values and split the shared archive.
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeUrl("  https://example.com/a?b=1  ")).toBe(
      "https://example.com/a?b=1",
    );
  });
});

describe("displayUrl", () => {
  it("stops a target forging the log line around it", () => {
    // A lone CR survives `parseUrlList` (it splits on /\r?\n/), and a crawl
    // takes its URLs from the audited site's own links.
    expect(displayUrl("https://evil.test/\r✓ everything passed")).toBe(
      "https://evil.test/ ✓ everything passed",
    );
    expect(displayUrl("https://evil.test/\u001b[2KFORGED")).not.toContain("\u001b");
    expect(displayUrl("https://a.test/\n\nb")).toBe("https://a.test/ b");
  });

  it("leaves an ordinary URL alone and clamps a huge one", () => {
    expect(displayUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(displayUrl(`https://x.test/${"a".repeat(5000)}`).length).toBeLessThanOrEqual(200);
  });
});

describe("control characters in a target (Phase F security re-review, L-d)", () => {
  const ESC = String.fromCharCode(27);
  const CR = String.fromCharCode(13);

  it("refuses a target containing control characters", () => {
    // WHATWG `URL` STRIPS tab/CR/LF while parsing, so such a target validates
    // cleanly — and since `normalizeUrl` returns the string as typed, the raw
    // CR would travel into `runs.url`. Refusing keeps the stored value matching
    // the web path (canonicalising would split the archive) and loses nothing:
    // no real target contains a control character.
    expect(() => normalizeUrl(`https://x.test/${CR}y`)).toThrow(CliUsageError);
    expect(() => normalizeUrl(`https://x.test/${CR}y`)).toThrow(/control characters/i);
    expect(() => normalizeUrl(`https://x.test/${ESC}[2Ky`)).toThrow(CliUsageError);
  });

  it("does not let a refused target forge the log line", () => {
    // Refusing is still echoing. `displayUrl` closed this on the success path;
    // the rejection path was raw until this fix.
    let message = "";
    try {
      normalizeUrl(`https://x.test/${ESC}[2K${CR}y`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(ESC);
    expect(message).not.toContain(CR);
  });

  it("leaves an ordinary target alone", () => {
    expect(normalizeUrl("https://x.test/a?b=1#c")).toBe("https://x.test/a?b=1#c");
  });
});
