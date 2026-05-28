import { describe, expect, it } from "vitest";

import type { HistoryRow } from "@/lib/db/persistence";
import {
  csvCell,
  rowsToCsv,
  rowsToJson,
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

describe("rowsToJson", () => {
  it("produces a pretty JSON array of export records", () => {
    const json = rowsToJson([makeRow()]);
    const parsed = JSON.parse(json) as ReturnType<typeof toExportRecord>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe("https://example.com/");
    expect(json).toContain("\n"); // pretty-printed
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

  it("escapes a URL containing a comma", () => {
    const csv = rowsToCsv([makeRow({ url: "https://example.com/a,b" })]);
    expect(csv).toContain('"https://example.com/a,b"');
  });
});
