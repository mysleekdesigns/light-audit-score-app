import { describe, expect, it } from "vitest";

import type { HistoryRow } from "@/lib/db/persistence";
import {
  csvCell,
  rowsToCsv,
  rowsToJson,
  runExportSlug,
  siteExportSlug,
  toExportRecord,
} from "@/lib/export/exporters";

/** Build a HistoryRow with sensible defaults, overridable per-test. */
function makeRow(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: "run-1",
    batchId: "batch-1",
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    status: "done",
    errorMessage: null,
    formFactor: "mobile",
    source: "local",
    field: null,
    runs: 3,
    options: {
      formFactor: "mobile",
      throttling: "simulated",
      categories: ["performance", "accessibility", "best-practices", "seo"],
      runs: 3,
      warmCache: true,
    },
    scores: {
      performance: 100,
      accessibility: 96,
      "best-practices": 92,
      seo: 80,
    },
    metrics: {
      "largest-contentful-paint": { numericValue: 812, displayValue: "0.8 s", score: 1 },
      "cumulative-layout-shift": { numericValue: 0.01, displayValue: "0.01", score: 1 },
      "total-blocking-time": { numericValue: 0, displayValue: "0 ms", score: 1 },
      "first-contentful-paint": { numericValue: 700, displayValue: "0.7 s", score: 1 },
      "speed-index": { numericValue: 1200, displayValue: "1.2 s", score: 1 },
      interactive: { numericValue: 900, displayValue: "0.9 s", score: 1 },
    },
    environment: null,
    hasJsonReport: true,
    hasHtmlReport: true,
    fetchTime: "2026-05-26T10:00:00.000Z",
    createdAt: "2026-05-26T10:00:05.000Z",
    ...overrides,
  };
}

describe("toExportRecord", () => {
  it("flattens scores and Core Web Vitals numeric values", () => {
    const record = toExportRecord(makeRow());
    expect(record.performance).toBe(100);
    expect(record.seo).toBe(80);
    expect(record.lcp).toBe(812);
    expect(record.cls).toBe(0.01);
    expect(record.tti).toBe(900);
    expect(record.device).toBe("mobile");
  });

  it("maps a failed run to null scores/metrics + the error message", () => {
    const record = toExportRecord(
      makeRow({
        status: "error",
        errorMessage: "Chrome failed to launch",
        runs: null,
        scores: {},
        metrics: null,
        fetchTime: null,
      }),
    );
    expect(record.status).toBe("error");
    expect(record.performance).toBeNull();
    expect(record.lcp).toBeNull();
    expect(record.errorMessage).toBe("Chrome failed to launch");
  });
});

describe("toExportRecord — agentic-browsing (Lighthouse 13.3's fifth category)", () => {
  it("exports the fifth score when the run has one", () => {
    const record = toExportRecord(
      makeRow({
        scores: {
          performance: 100,
          accessibility: 96,
          "best-practices": 92,
          seo: 80,
          "agentic-browsing": 67,
        },
      }),
    );
    expect(record["agentic-browsing"]).toBe(67);
  });

  it("exports null — never 0 — for a run that didn't score it", () => {
    // makeRow()'s default scores carry only the four weighted categories, which
    // is exactly what a legacy row (or a run that didn't select it) reads back as.
    const record = toExportRecord(makeRow());
    expect(record["agentic-browsing"]).toBeNull();
    expect(record["agentic-browsing"]).not.toBe(0);
    // An explicit null score behaves the same way.
    expect(
      toExportRecord(makeRow({ scores: { "agentic-browsing": null } }))[
        "agentic-browsing"
      ],
    ).toBeNull();
  });
});

describe("rowsToJson", () => {
  it("produces a pretty JSON array of export records", () => {
    const json = rowsToJson([makeRow()]);
    const parsed = JSON.parse(json) as ReturnType<typeof toExportRecord>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe("https://example.com/");
    expect(json).toContain("\n"); // pretty-printed
  });
});

describe("runExportSlug", () => {
  it("names a run <host>-<path>-<device>, dropping www.", () => {
    expect(runExportSlug(makeRow({ url: "https://www.example.com/pricing/" }))).toBe(
      "example.com-pricing-mobile",
    );
  });

  it("omits the path part for a bare origin", () => {
    expect(
      runExportSlug(makeRow({ url: "https://example.com/", formFactor: "desktop" })),
    ).toBe("example.com-desktop");
  });

  it("lower-cases, decodes escapes, and flattens the query string into single dashes", () => {
    expect(runExportSlug(makeRow({ url: "https://Example.com/Search?q=a%20b&x=1" }))).toBe(
      "example.com-search-q-a-b-x-1-mobile",
    );
  });

  it("caps a long path so the filename stays OS-safe, with no trailing dash", () => {
    const slug = runExportSlug(
      makeRow({ url: `https://example.com/${"segment/".repeat(20)}` }),
    );
    expect(slug.startsWith("example.com-")).toBe(true);
    expect(slug.endsWith("-mobile")).toBe(true);
    const path = slug.slice("example.com-".length, -"-mobile".length);
    expect(path.length).toBeLessThanOrEqual(40);
    expect(path.endsWith("-")).toBe(false);
  });

  it("slugs a string that is not a URL instead of throwing", () => {
    expect(runExportSlug(makeRow({ url: "not a url" }))).toBe("not-a-url-mobile");
  });
});

describe("siteExportSlug", () => {
  it("keeps a hostname's dots and drops a leading www.", () => {
    expect(siteExportSlug("crawlforge.dev")).toBe("crawlforge.dev");
    expect(siteExportSlug("www.example.com")).toBe("example.com");
  });

  it("lower-cases and dashes anything that is not a hostname character", () => {
    expect(siteExportSlug("Not A Host")).toBe("not-a-host");
  });
});

describe("csvCell", () => {
  it("leaves simple values unquoted", () => {
    expect(csvCell("example.com")).toBe("example.com");
    expect(csvCell(90)).toBe("90");
  });

  it("renders null as an empty cell", () => {
    expect(csvCell(null)).toBe("");
  });

  it("quotes and escapes commas, quotes, and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("rowsToCsv", () => {
  it("emits a header row plus one CRLF-delimited row per run", () => {
    const csv = rowsToCsv([makeRow(), makeRow({ id: "run-2", url: "https://example.com/a" })]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[0]).toContain("url,finalUrl,device,status,runs");
    expect(lines[0]).toContain("performance");
    expect(lines[0]).toContain("lcp");
    expect(lines[1]).toContain("https://example.com/");
    expect(lines[1]).toContain("100");
  });

  it("appends the agentic-browsing column after seo, empty when unscored", () => {
    const csv = rowsToCsv([
      makeRow({
        scores: {
          performance: 100,
          accessibility: 96,
          "best-practices": 92,
          seo: 80,
          "agentic-browsing": 67,
        },
      }),
      makeRow({ id: "run-2" }), // default row: no fifth score
    ]);
    const [header, scored, unscored] = csv.split("\r\n");
    const columns = header.split(",");
    // Canonical LIGHTHOUSE_CATEGORIES order: the fifth follows seo, so every
    // pre-existing column keeps its position.
    expect(columns.indexOf("agentic-browsing")).toBe(columns.indexOf("seo") + 1);
    expect(scored.split(",")[columns.indexOf("agentic-browsing")]).toBe("67");
    // Unscored → an empty cell, not a "0".
    expect(unscored.split(",")[columns.indexOf("agentic-browsing")]).toBe("");
  });

  it("escapes a URL containing a comma", () => {
    const csv = rowsToCsv([makeRow({ url: "https://example.com/a,b" })]);
    expect(csv).toContain('"https://example.com/a,b"');
  });
});

describe("csvCell formula injection", () => {
  // ROADMAP Phase A's review raised this and left it as pre-existing; Phase F
  // makes it live, because `--reporter csv` writes a file CI archives and a
  // human later opens in a spreadsheet.
  it("neutralises every formula leader, including the control-character bypass", () => {
    for (const payload of [
      '=HYPERLINK("https://evil.test","click")',
      "+1+1",
      "-1+1",
      "@SUM(A1:A9)",
      "\tcmd",
      "\r=1+1",
    ]) {
      const cell = csvCell(payload);
      // Quoted, and the leading apostrophe makes the spreadsheet read it as text.
      expect(cell.startsWith(`"'`)).toBe(true);
      // Every original character survives — the prefix adds, it never substitutes.
      expect(cell).toContain(payload.replace(/"/g, '""'));
      // And the exact cell, so the cost is asserted rather than implied: a
      // parser reads the apostrophe back as part of the value. This is NOT a
      // lossless round-trip, and the docblock says so.
      expect(cell).toBe(`"'${payload.replace(/"/g, '""')}"`);
    }
  });

  it("leaves an ordinary value untouched", () => {
    expect(csvCell("https://example.com/a")).toBe("https://example.com/a");
    expect(csvCell(93)).toBe("93");
    expect(csvCell(null)).toBe("");
  });

  it("still escapes RFC 4180 specials, and both rules at once", () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    // A formula leader AND an interior quote: quoted once, quotes doubled once.
    expect(csvCell('=x"y')).toBe(`"'=x""y"`);
  });
});
