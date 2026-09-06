/**
 * Client-report assembly tests (ROADMAP Phase H).
 *
 * Almost everything here runs against literal fixtures through the pure half of
 * `report-data.ts` — `assembleReport` and the projections it composes — because
 * that is the whole document's shape and standing up SQLite to assert it would
 * only test drizzle. The one DB-backed case is the one that cannot be faked: an
 * unknown batch id has to resolve to `null` against a real (empty) archive, so
 * that suite borrows `persistence.test.ts`'s throwaway-data-dir pattern.
 *
 * The load-bearing test is "the summary is the app's summary": it asserts field
 * by field that the exported aggregates ARE `@/lib/batch-summary/summary`'s
 * output for the same rows and thresholds. That is the phase's Gate — a report a
 * client can hold beside the dashboard must agree with it — expressed as a
 * property rather than as a list of expected numbers, so it keeps holding if the
 * aggregation itself ever changes.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  averageScores,
  bestWorstPages,
  overallScore,
  pagesClearingThresholds,
  passFail,
} from "@/lib/batch-summary/summary";
import { resetDbForTests } from "@/lib/db/client";
import type { BatchStatus } from "@/lib/queue/types";
import type { BatchInfo, HistoryRow } from "@/lib/db/persistence";
import {
  assemblePage,
  assembleReport,
  buildClientReport,
  buildNotes,
  condenseDescription,
  deviceLabel,
  resolveThresholds,
  sampleFrames,
  sanitizeBranding,
  toReportMetrics,
  toReportOpportunities,
  toReportWaterfall,
  type PageTrace,
  type TruncationTally,
} from "@/lib/export/report-data";
import {
  BRANDING_LIMITS,
  EMPTY_BRANDING,
  REPORT_CAPS,
} from "@/lib/export/report-model";
import { renderClientReport } from "@/lib/export/report-html";
import type {
  CategoryScores,
  CoreWebVitals,
  MetricId,
  MetricValue,
  Opportunity,
} from "@/lib/lighthouse/types";
import type {
  FilmstripData,
  FilmstripFrame,
  WaterfallData,
  WaterfallRequest,
} from "@/lib/reports/types";
import { DEFAULT_THRESHOLDS } from "@/lib/settings/defaults";

const FRAME = "data:image/jpeg;base64,/9j/4AAQ";
const GENERATED_AT = new Date("2026-09-06T12:00:00.000Z");
const THRESHOLDS = resolveThresholds(DEFAULT_THRESHOLDS);

// --- Fixtures ----------------------------------------------------------------

/** A minimal {@link HistoryRow}; only the fields under assertion are overridden. */
function makeRow(overrides: Partial<HistoryRow> & { id: string }): HistoryRow {
  return {
    id: overrides.id,
    batchId: overrides.batchId ?? "batch-1234abcd-tail",
    url: overrides.url ?? `https://example.com/${overrides.id}`,
    finalUrl: overrides.finalUrl ?? null,
    status: overrides.status ?? "done",
    errorMessage: overrides.errorMessage ?? null,
    formFactor: overrides.formFactor ?? "mobile",
    source: overrides.source ?? "local",
    runs: overrides.runs ?? 3,
    options: overrides.options ?? {
      formFactor: "mobile",
      throttling: "simulated",
      categories: ["performance", "accessibility", "best-practices", "seo"],
      runs: 3,
      warmCache: true,
    },
    scores: overrides.scores ?? scores(90, 95, 92, 100),
    metrics: overrides.metrics ?? null,
    field: overrides.field ?? null,
    environment: overrides.environment ?? null,
    hasJsonReport: overrides.hasJsonReport ?? true,
    hasHtmlReport: overrides.hasHtmlReport ?? true,
    fetchTime: overrides.fetchTime ?? "2026-09-06T11:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-09-06T11:00:00.000Z",
  };
}

/** A minimal {@link BatchInfo} whose id is long enough to have a short form. */
function makeBatch(overrides: Partial<BatchInfo> = {}): BatchInfo {
  return {
    id: overrides.id ?? "batch-1234abcd-tail",
    status: overrides.status ?? "completed",
    source: overrides.source ?? "local",
    options: overrides.options ?? {
      formFactor: "mobile",
      throttling: "simulated",
      categories: ["performance", "accessibility", "best-practices", "seo"],
      runs: 3,
      warmCache: true,
    },
    concurrency: overrides.concurrency ?? 3,
    total: overrides.total ?? 2,
    priorBatchId: overrides.priorBatchId ?? null,
    scheduleId: overrides.scheduleId ?? null,
    createdAt: overrides.createdAt ?? "2026-09-06T10:00:00.000Z",
    startedAt: overrides.startedAt ?? "2026-09-06T10:00:01.000Z",
    finishedAt: overrides.finishedAt ?? "2026-09-06T10:05:00.000Z",
  };
}

const scores = (
  performance: number | null,
  accessibility: number | null,
  bestPractices: number | null,
  seo: number | null,
): CategoryScores => ({
  performance,
  accessibility,
  "best-practices": bestPractices,
  seo,
  "agentic-browsing": null,
});

/** A {@link CoreWebVitals} record with every key present, most of them absent. */
function metrics(present: Partial<Record<MetricId, MetricValue>>): CoreWebVitals {
  return {
    "largest-contentful-paint": present["largest-contentful-paint"] ?? null,
    "cumulative-layout-shift": present["cumulative-layout-shift"] ?? null,
    "total-blocking-time": present["total-blocking-time"] ?? null,
    "first-contentful-paint": present["first-contentful-paint"] ?? null,
    "speed-index": present["speed-index"] ?? null,
    interactive: present.interactive ?? null,
  };
}

function request(overrides: Partial<WaterfallRequest> = {}): WaterfallRequest {
  return {
    index: overrides.index ?? 0,
    url: overrides.url ?? "https://example.com/app.js",
    path: overrides.path ?? "/app.js",
    host: overrides.host ?? "example.com",
    resourceType: overrides.resourceType ?? "Script",
    mimeType: "application/javascript",
    transferSize: overrides.transferSize ?? 1_000,
    resourceSize: 4_000,
    statusCode: 200,
    protocol: "h2",
    priority: "High",
    startTime: overrides.startTime ?? 20,
    endTime: overrides.endTime ?? 120,
    durationMs: 100,
    thirdParty: overrides.thirdParty ?? false,
    entity: "example.com",
    renderBlocking: overrides.renderBlocking ?? false,
    finished: true,
    cache: "none",
  };
}

/** `count` frames 100 ms apart, with the LCP mark on `lcpIndex` (none by default). */
function makeFrames(count: number, lcpIndex = -1): FilmstripFrame[] {
  return Array.from({ length: count }, (_unused, index) => ({
    timingMs: (index + 1) * 100,
    data: FRAME,
    isLcp: index === lcpIndex,
  }));
}

function waterfall(overrides: Partial<WaterfallData> = {}): WaterfallData {
  const requests = overrides.requests ?? [request()];
  return {
    requests,
    totalTransferSize: overrides.totalTransferSize ?? requests.length * 1_000,
    totalResourceSize: 0,
    timelineMs: overrides.timelineMs ?? 1_200,
    thirdPartyCount: overrides.thirdPartyCount ?? 0,
    unavailable: overrides.unavailable ?? false,
  };
}

function filmstrip(overrides: Partial<FilmstripData> = {}): FilmstripData {
  const frames = overrides.frames ?? makeFrames(3, 1);
  return {
    frames,
    lcpMs: overrides.lcpMs ?? 200,
    timelineMs: frames.length === 0 ? null : frames[frames.length - 1].timingMs,
    unavailable: overrides.unavailable ?? false,
  };
}

function opportunity(id: string, savingsMs: number | null): Opportunity {
  return {
    id,
    title: `Fix ${id}`,
    description: `Why ${id} matters.`,
    savingsMs,
    displayValue: savingsMs === null ? "" : `Est savings of ${savingsMs} ms`,
    score: 0.5,
  };
}

/** A readable stored report for a run. */
function okTrace(overrides: Partial<Extract<PageTrace, { status: "ok" }>> = {}): PageTrace {
  return {
    status: "ok",
    opportunities: overrides.opportunities ?? [],
    waterfall: overrides.waterfall ?? waterfall(),
    filmstrip: overrides.filmstrip ?? filmstrip(),
    lighthouseVersion: overrides.lighthouseVersion ?? "13.0.0",
  };
}

function traceMap(entries: Record<string, PageTrace>): Map<string, PageTrace> {
  return new Map(Object.entries(entries));
}

// --- Thresholds, labels, branding --------------------------------------------

describe("resolveThresholds", () => {
  it("fills every missing category with the 90 fallback", () => {
    expect(resolveThresholds({ performance: 50 })).toEqual({
      performance: 50,
      accessibility: 90,
      "best-practices": 90,
      seo: 90,
      "agentic-browsing": 90,
    });
  });

  it("passes a supplied value through unrounded, so the report judges as the app did", () => {
    expect(resolveThresholds({ performance: 89.5 }).performance).toBe(89.5);
  });

  it("treats a non-finite bar as unset", () => {
    expect(resolveThresholds({ seo: Number.NaN }).seo).toBe(90);
  });
});

describe("deviceLabel", () => {
  it("reads the devices off the runs, not off the batch options", () => {
    const rows = [
      makeRow({ id: "r1", formFactor: "mobile" }),
      makeRow({ id: "r2", formFactor: "desktop" }),
    ];
    expect(deviceLabel(rows, "mobile")).toBe("Mobile + Desktop");
    expect(deviceLabel([rows[1]], "mobile")).toBe("Desktop");
    expect(deviceLabel([rows[0]], "desktop")).toBe("Mobile");
  });

  it("falls back to the batch's device when there are no runs", () => {
    expect(deviceLabel([], "desktop")).toBe("Desktop");
  });
});

describe("sanitizeBranding", () => {
  it("drops a logo that is not a data: image", () => {
    const branding = sanitizeBranding({
      title: "Acme Audits",
      subtitle: "",
      logoDataUri: "https://acme.test/logo.png",
      showDate: true,
    });
    expect(branding.logoDataUri).toBe("");
    expect(branding.title).toBe("Acme Audits");
  });

  it("keeps a data: image and flattens the header text", () => {
    // A REAL 1x1 PNG. A stub body would no longer do: assembly now runs the
    // contract's `sanitizeLogoDataUri`, which checks base64 canonicality and the
    // decoded size rather than only the prefix.
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const branding = sanitizeBranding({
      title: "Acme\nAudits",
      subtitle: "  Performance  review  ",
      logoDataUri: png,
      showDate: false,
    });
    expect(branding).toEqual({
      title: "Acme Audits",
      subtitle: "Performance review",
      logoDataUri: png,
      showDate: false,
    });
  });

  /**
   * Phase H security review, M2: this layer used to test only the 22-character
   * prefix, so a caller supplying its own branding got neither the size cap nor
   * the base64 check. These are that finding, as tests.
   */
  it("refuses a well-prefixed logo whose body is not canonical base64", () => {
    // The reviewer's own case: correct prefix, markup for a payload.
    expect(
      sanitizeBranding({
        ...EMPTY_BRANDING,
        title: "Kept",
        logoDataUri: 'data:image/png;base64,"><img src=x onerror=alert(1)>',
        showDate: true,
      }),
    ).toEqual({ title: "Kept", subtitle: "", logoDataUri: "", showDate: true });
  });

  it("refuses a logo over the decoded-size cap", () => {
    const huge = `data:image/png;base64,${"A".repeat(BRANDING_LIMITS.logoMaxBytes * 2)}`;
    expect(
      sanitizeBranding({ ...EMPTY_BRANDING, logoDataUri: huge }).logoDataUri,
    ).toBe("");
  });

  it("refuses SVG here too, so store, assembly and renderer agree", () => {
    expect(
      sanitizeBranding({
        ...EMPTY_BRANDING,
        logoDataUri: "data:image/svg+xml;base64,PHN2Zy8+",
      }).logoDataUri,
    ).toBe("");
  });
});

// --- Filmstrip sampling ------------------------------------------------------

describe("sampleFrames", () => {
  it("returns every frame when the strip is already within the cap", () => {
    const frames = makeFrames(REPORT_CAPS.frames);
    expect(sampleFrames(frames)).toEqual(frames);
  });

  it("caps the strip and keeps its first and last frames", () => {
    const frames = makeFrames(30);
    const sampled = sampleFrames(frames);

    expect(sampled).toHaveLength(REPORT_CAPS.frames);
    expect(sampled[0]).toBe(frames[0]);
    expect(sampled[sampled.length - 1]).toBe(frames[29]);
  });

  it("samples across the whole strip rather than taking the first N", () => {
    const sampled = sampleFrames(makeFrames(30));
    // The last frame is at 3000 ms; a `slice(0, 8)` would end at 800 ms.
    expect(sampled.map((frame) => frame.timingMs)).toEqual([
      100, 500, 900, 1300, 1800, 2200, 2600, 3000,
    ]);
  });

  it("keeps the LCP frame, without giving up an end of the strip", () => {
    const frames = makeFrames(30, 6);
    const sampled = sampleFrames(frames);

    expect(sampled).toHaveLength(REPORT_CAPS.frames);
    expect(sampled).toContain(frames[6]);
    expect(sampled[0]).toBe(frames[0]);
    expect(sampled[sampled.length - 1]).toBe(frames[29]);
    // Still in capture order after the swap.
    expect(sampled.map((frame) => frame.timingMs)).toEqual(
      [...sampled.map((frame) => frame.timingMs)].sort((a, b) => a - b),
    );
  });

  it("never exceeds the cap for any strip length", () => {
    for (let length = 1; length <= 60; length += 1) {
      const sampled = sampleFrames(makeFrames(length, length - 2));
      expect(sampled.length).toBeLessThanOrEqual(REPORT_CAPS.frames);
      expect(new Set(sampled).size).toBe(sampled.length);
    }
  });

  it("handles an empty strip", () => {
    expect(sampleFrames([])).toEqual([]);
  });
});

// --- Waterfall ---------------------------------------------------------------

describe("toReportWaterfall", () => {
  it("truncates the rows while the totals still describe every request", () => {
    const requests = Array.from({ length: 312 }, (_unused, index) =>
      request({
        index,
        path: `/asset-${index}.js`,
        transferSize: 1_000,
        thirdParty: index % 2 === 0,
      }),
    );
    const projected = toReportWaterfall(
      waterfall({ requests, totalTransferSize: 312_000, thirdPartyCount: 156 }),
    );

    expect(projected.requests).toHaveLength(REPORT_CAPS.requests);
    expect(projected.requests[0].path).toBe("/asset-0.js");
    expect(projected.totalRequests).toBe(312);
    expect(projected.totalTransferSize).toBe(312_000);
    expect(projected.thirdPartyCount).toBe(156);
  });

  it("flattens the page-authored strings on a row", () => {
    const projected = toReportWaterfall(
      waterfall({
        requests: [
          request({ path: "/a\nb c", host: "evil‮test.com", resourceType: "Scr\tipt" }),
        ],
      }),
    );

    expect(projected.requests[0].path).toBe("/a b c");
    expect(projected.requests[0].host).toBe("eviltest.com");
    expect(projected.requests[0].resourceType).toBe("Scr ipt");
  });
});

// --- Opportunities -----------------------------------------------------------

describe("toReportOpportunities", () => {
  it("orders by saving, sorts an unmeasured saving last, and caps", () => {
    const projected = toReportOpportunities([
      opportunity("small", 10),
      opportunity("unknown", null),
      opportunity("largest", 900),
      opportunity("zero", 0),
      opportunity("big", 400),
      opportunity("medium", 200),
      opportunity("tiny", 5),
    ]);

    expect(projected).toHaveLength(REPORT_CAPS.opportunities);
    expect(projected.map((item) => item.id)).toEqual([
      "largest",
      "big",
      "medium",
      "small",
      "tiny",
    ]);
  });

  it("keeps an unmeasured saving as null rather than inventing a zero", () => {
    const [projected] = toReportOpportunities([opportunity("unknown", null)]);
    expect(projected.savingsMs).toBeNull();
    expect(projected.displayValue).toBe("");
  });
});

// --- Metrics -----------------------------------------------------------------

describe("toReportMetrics", () => {
  it("emits every metric in display order, dashing the ones the run lacks", () => {
    const projected = toReportMetrics(
      makeRow({
        id: "r1",
        metrics: metrics({
          "largest-contentful-paint": {
            numericValue: 1_200,
            displayValue: "1.2 s",
            score: 0.9,
          },
        }),
      }),
    );

    expect(projected.map((metric) => metric.abbr)).toEqual([
      "LCP",
      "CLS",
      "TBT",
      "FCP",
      "SI",
      "TTI",
    ]);
    expect(projected[0]).toMatchObject({
      label: "Largest Contentful Paint",
      displayValue: "1.2 s",
      numericValue: 1_200,
      score: 0.9,
    });
    expect(projected[5]).toMatchObject({
      displayValue: "—",
      numericValue: null,
      score: null,
    });
  });

  it("emits nothing for a run that measured nothing", () => {
    expect(toReportMetrics(makeRow({ id: "r1", metrics: null }))).toEqual([]);
  });
});

// --- Page assembly -----------------------------------------------------------

describe("assemblePage", () => {
  it("flattens the strings the audited page chose", () => {
    const page = assemblePage(
      makeRow({
        id: "r1",
        url: "https://evil.test/a\nb",
        finalUrl: "https://evil.test/‮gnp.exe",
        status: "error",
        errorMessage: "NO_FCP\r\nChrome didn't collect any  frames",
      }),
      { status: "omitted", omission: "no-report" },
      THRESHOLDS,
    );

    expect(page.url).toBe("https://evil.test/a b");
    expect(page.finalUrl).toBe("https://evil.test/gnp.exe");
    expect(page.errorMessage).toBe("NO_FCP Chrome didn't collect any frames");
  });

  it("clamps a pathological URL rather than carrying it into the file", () => {
    const page = assemblePage(
      makeRow({ id: "r1", url: `https://evil.test/${"a".repeat(5_000)}` }),
      okTrace(),
      THRESHOLDS,
    );
    expect(page.url.length).toBeLessThanOrEqual(300);
    expect(page.url.endsWith("…")).toBe(true);
  });

  it("blanks a finalUrl that merely echoes the requested URL", () => {
    const url = "https://example.com/pricing";
    const page = assemblePage(
      makeRow({ id: "r1", url, finalUrl: url }),
      okTrace(),
      THRESHOLDS,
    );
    expect(page.finalUrl).toBe("");
  });

  it("projects a readable report into both halves of the trace", () => {
    const page = assemblePage(
      makeRow({ id: "r1" }),
      okTrace({ opportunities: [opportunity("unused-javascript", 450)] }),
      THRESHOLDS,
    );

    expect(page.traceOmission).toBeNull();
    expect(page.waterfall?.totalRequests).toBe(1);
    expect(page.filmstrip?.frames).toHaveLength(3);
    expect(page.opportunities.map((item) => item.id)).toEqual(["unused-javascript"]);
  });

  it("reports a report that carried neither audit as unavailable, not unreadable", () => {
    const page = assemblePage(
      makeRow({ id: "r1" }),
      okTrace({
        waterfall: waterfall({ requests: [], unavailable: true }),
        filmstrip: filmstrip({ frames: [], unavailable: true }),
      }),
      THRESHOLDS,
    );

    expect(page.waterfall).toBeNull();
    expect(page.filmstrip).toBeNull();
    expect(page.traceOmission).toBe("unavailable");
  });

  it("keeps the half a mixed report has, and omits nothing", () => {
    const page = assemblePage(
      makeRow({ id: "r1" }),
      okTrace({ filmstrip: filmstrip({ frames: [], unavailable: true }) }),
      THRESHOLDS,
    );

    expect(page.waterfall).not.toBeNull();
    expect(page.filmstrip).toBeNull();
    expect(page.traceOmission).toBeNull();
  });

  it("carries an unreadable report through as unreadable", () => {
    const page = assemblePage(
      makeRow({ id: "r1" }),
      { status: "omitted", omission: "unreadable" },
      THRESHOLDS,
    );
    expect(page.traceOmission).toBe("unreadable");
  });

  it("judges `clears` against the supplied thresholds", () => {
    const row = makeRow({ id: "r1", scores: scores(80, 95, 92, 100) });
    expect(assemblePage(row, okTrace(), THRESHOLDS).clears).toBe(false);
    expect(
      assemblePage(row, okTrace(), resolveThresholds({ performance: 80 })).clears,
    ).toBe(true);
  });
});

// --- Notes -------------------------------------------------------------------

describe("buildNotes", () => {
  const empty: TruncationTally = {
    pages: { shown: 2, total: 2 },
    requests: { pages: 0, total: 0 },
    frames: { pages: 0, total: 0 },
    opportunityPages: 0,
    highlightOutsidePages: false,
    batch: { status: "completed", ran: 2, total: 2 },
  };

  it("says nothing when nothing was left out", () => {
    expect(buildNotes(empty)).toEqual([]);
  });

  it("names each cap that bit, once", () => {
    expect(
      buildNotes({
        ...empty,
        pages: { shown: 60, total: 312 },
        requests: { pages: 3, total: 312 },
        frames: { pages: 1, total: 27 },
        opportunityPages: 4,
        highlightOutsidePages: true,
      }),
    ).toEqual([
      "Showing 60 of 312 pages. The summary covers all 312.",
      "Showing 40 of 312 requests for 3 pages.",
      "Sampled 8 of 27 filmstrip frames for 1 page.",
      "Showing the top 5 opportunities for 4 pages.",
      "The best or worst page is not among the pages listed below.",
    ]);
  });
});

// --- Whole-report assembly ---------------------------------------------------

describe("assembleReport", () => {
  const rows = [
    makeRow({ id: "run-a", url: "https://example.com/", scores: scores(95, 98, 92, 100) }),
    makeRow({ id: "run-b", url: "https://example.com/pricing", scores: scores(41, 88, 75, 90) }),
    makeRow({
      id: "run-c",
      url: "https://example.com/broken",
      status: "error",
      errorMessage: "Chrome did not respond",
      runs: null,
      fetchTime: null,
      scores: scores(null, null, null, null),
      metrics: null,
      hasJsonReport: false,
    }),
  ];

  function report(overrides: Partial<Parameters<typeof assembleReport>[0]> = {}) {
    return assembleReport({
      batch: makeBatch(),
      rows,
      traces: traceMap({ "run-a": okTrace(), "run-b": okTrace() }),
      thresholds: THRESHOLDS,
      branding: EMPTY_BRANDING,
      generatedAt: GENERATED_AT,
      ...overrides,
    });
  }

  it("stamps the version, the short id and the injected clock", () => {
    const built = report();
    expect(built.version).toBe(1);
    expect(built.batchId).toBe("batch-1234abcd-tail");
    // The 8-char form the Batch Summary card prints.
    expect(built.shortId).toBe("batch-12");
    expect(built.generatedAt).toBe("2026-09-06T12:00:00.000Z");
  });

  it("aggregates exactly as the app's Batch Summary does", () => {
    const { summary } = report();

    expect(summary.averageScores).toEqual(averageScores(rows));
    expect(summary.overall).toBe(overallScore(averageScores(rows)));
    expect(summary.passFail).toEqual(passFail(rows, THRESHOLDS));
    expect(summary.clearing).toEqual(pagesClearingThresholds(rows, THRESHOLDS));

    const { best, worst } = bestWorstPages(rows);
    expect(summary.best?.runId).toBe(best?.id);
    expect(summary.worst?.runId).toBe(worst?.id);
    expect(summary.best?.overall).toBe(overallScore(best?.scores ?? {}));
  });

  it("counts the failed run as an error page with nothing to read", () => {
    const built = report();
    const failed = built.pages.find((page) => page.runId === "run-c");

    expect(built.summary.pageCount).toBe(3);
    expect(built.summary.errorCount).toBe(1);
    expect(failed).toMatchObject({
      status: "error",
      traceOmission: "no-report",
      errorMessage: "Chrome did not respond",
      runs: null,
      fetchTime: null,
      overall: null,
      clears: false,
    });
    expect(failed?.waterfall).toBeNull();
    expect(failed?.filmstrip).toBeNull();
    expect(failed?.metrics).toEqual([]);
  });

  it("keeps the rows in the app's order and needs no notes when nothing is cut", () => {
    const built = report();
    expect(built.pages.map((page) => page.runId)).toEqual(["run-a", "run-b", "run-c"]);
    expect(built.notes).toEqual([]);
  });

  it("prints the batch's provenance, with the device read off the runs", () => {
    const built = report({
      rows: [rows[0], makeRow({ id: "run-d", formFactor: "desktop" })],
      traces: traceMap({ "run-a": okTrace({ lighthouseVersion: "13.1.0" }) }),
    });

    expect(built.provenance).toEqual({
      source: "local",
      device: "Mobile + Desktop",
      throttling: "Simulated",
      runs: 3,
      lighthouseVersion: "13.1.0",
      createdAt: "2026-09-06T10:00:00.000Z",
      status: "completed",
      total: 2,
    });
  });

  it("prefers the throttling Lighthouse actually applied", () => {
    const built = report({
      rows: [
        makeRow({
          id: "run-a",
          environment: {
            benchmarkIndex: 1_500,
            hostUserAgent: "",
            throttlingMethod: "devtools",
            cpuSlowdownMultiplier: 4,
          },
        }),
      ],
      traces: traceMap({}),
    });
    expect(built.provenance.throttling).toBe("Applied");
  });

  it("leaves the version empty when no readable run recorded one", () => {
    expect(report({ traces: traceMap({}) }).provenance.lighthouseVersion).toBe("");
  });

  it("caps the pages, keeps the summary over the whole batch, and says so", () => {
    const many = Array.from({ length: 65 }, (_unused, index) =>
      makeRow({ id: `run-${index}`, scores: scores(index % 100, 90, 90, 90) }),
    );
    const built = assembleReport({
      batch: makeBatch(),
      rows: many,
      traces: traceMap({}),
      thresholds: THRESHOLDS,
      branding: EMPTY_BRANDING,
      generatedAt: GENERATED_AT,
    });

    expect(built.pages).toHaveLength(REPORT_CAPS.pages);
    expect(built.summary.pageCount).toBe(REPORT_CAPS.pages);
    // The header still describes all 65 — the note is what reconciles the two.
    expect(built.summary.averageScores).toEqual(averageScores(many));
    expect(built.notes[0]).toBe("Showing 60 of 65 pages. The summary covers all 65.");
  });

  it("notes every cap that bit while assembling", () => {
    const built = report({
      // `total: 1` so this test sees ONLY the cap notes. With the default
      // two-job batch the completeness note fires as well — correctly, since one
      // run of two really is a partial batch — and that belongs in its own test.
      batch: makeBatch({ total: 1 }),
      rows: [rows[0]],
      traces: traceMap({
        "run-a": okTrace({
          waterfall: waterfall({
            requests: Array.from({ length: 100 }, (_unused, index) =>
              request({ index, path: `/asset-${index}.js` }),
            ),
          }),
          filmstrip: filmstrip({ frames: makeFrames(20, 5) }),
          opportunities: Array.from({ length: 9 }, (_unused, index) =>
            opportunity(`o${index}`, index * 100),
          ),
        }),
      }),
    });

    expect(built.notes).toEqual([
      "Showing 40 of 100 requests for 1 page.",
      "Sampled 8 of 20 filmstrip frames for 1 page.",
      "Showing the top 5 opportunities for 1 page.",
    ]);
  });

  it("treats a run with no trace entry as one whose report was never found", () => {
    const built = report({ rows: [rows[0]], traces: traceMap({}) });
    expect(built.pages[0].traceOmission).toBe("no-report");
  });

  it("defaults the header block to nothing when the caller has none", () => {
    expect(report().branding).toEqual(EMPTY_BRANDING);
  });
});

// --- Database-backed entry point ---------------------------------------------

describe("buildClientReport", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-report-"));
    process.env.LH_DATA_DIR = tmpDir;
    process.env.LH_DB_PATH = path.join(tmpDir, "test.db");
    resetDbForTests();
  });

  afterEach(async () => {
    resetDbForTests();
    delete process.env.LH_DATA_DIR;
    delete process.env.LH_DB_PATH;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null for a batch id the archive does not have", async () => {
    await expect(buildClientReport({ batchId: "no-such-batch" })).resolves.toBeNull();
  });
});

describe("condenseDescription", () => {
  it("drops a trailing Lighthouse 'Learn more' markdown link, keeping the prose", () => {
    const raw =
      "Keep the server response time for the main document short because all other requests depend on it. [Learn more about the Time to First Byte metric](https://developer.chrome.com/docs/lighthouse/performance/time-to-first-byte/).";
    expect(condenseDescription(raw)).toBe(
      "Keep the server response time for the main document short because all other requests depend on it.",
    );
  });

  it("drops a mid-sentence link and every link when there are several", () => {
    const raw =
      "Minify CSS [Learn how](https://example.test/a) and JS [Learn how too](https://example.test/b) now";
    const out = condenseDescription(raw);
    expect(out).not.toContain("https://");
    expect(out).not.toContain("[");
    expect(out).toContain("Minify CSS");
    expect(out).toContain("now");
  });

  it("leaves a description with no link untouched", () => {
    const raw = "Serve images in next-gen formats.";
    expect(condenseDescription(raw)).toBe(raw);
  });

  it("reaches the projected opportunity, so no raw markdown can be exported", () => {
    const [projected] = toReportOpportunities([
      {
        id: "server-response-time",
        title: "Reduce initial server response time",
        description:
          "Root document took 7,530 ms. [Learn more](https://developer.chrome.com/docs/x/).",
        savingsMs: 6430,
        displayValue: "Root document took 7,530 ms",
        score: 0,
      },
    ]);
    expect(projected.description).not.toContain("[");
    expect(projected.description).not.toContain("https://");
    expect(projected.description).toContain("Root document took 7,530 ms.");
  });
});

/**
 * ROADMAP Phase H security review, finding 3: a batch that never finished must
 * not export as though it were the whole audit. These assert the sentence a
 * CLIENT would need in order not to be misled, which is why they check the note
 * text rather than only a status field.
 */
describe("incomplete batches are declared, not silently shrunk", () => {
  const partial = (status: BatchStatus, ran: number, total: number) =>
    buildNotes({
      pages: { shown: ran, total: ran },
      requests: { pages: 0, total: 0 },
      frames: { pages: 0, total: 0 },
      opportunityPages: 0,
      highlightOutsidePages: false,
      batch: { status, ran, total },
    });

  it("says a cancelled batch was cancelled, and how much of it never ran", () => {
    const [note] = partial("cancelled", 5, 20);
    expect(note).toContain("cancelled after 5 of its 20 pages");
    expect(note).toContain("never audited");
  });

  it("says a running batch is provisional", () => {
    const [note] = partial("running", 3, 10);
    expect(note).toContain("still running");
    expect(note).toContain("provisional");
  });

  it("puts the completeness note FIRST, so it qualifies the numbers below it", () => {
    const notes = buildNotes({
      pages: { shown: 5, total: 5 },
      requests: { pages: 2, total: 300 },
      frames: { pages: 1, total: 20 },
      opportunityPages: 1,
      highlightOutsidePages: false,
      batch: { status: "cancelled", ran: 5, total: 20 },
    });
    expect(notes[0]).toContain("cancelled");
    expect(notes.length).toBeGreaterThan(1);
  });

  it("stays silent for a batch that completed exactly as planned", () => {
    expect(partial("completed", 12, 12)).toEqual([]);
  });

  it("does not cry 'incomplete' for a both-devices batch, where total counts JOBS", () => {
    // Six URLs on mobile AND desktop is twelve jobs and twelve runs — complete.
    expect(partial("completed", 12, 12)).toEqual([]);
  });

  it("reports a terminal batch whose runs were deleted from History", () => {
    const [note] = partial("completed", 2, 9);
    expect(note).toContain("2 of this batch's 9 pages are in the archive");
    expect(note).toContain("no longer stored");
  });

  it("carries the lifecycle into the provenance the document prints", () => {
    const built = assembleReport({
      batch: makeBatch({ status: "cancelled", total: 20 }),
      rows: [
        makeRow({ id: "run-a", url: "https://example.com/" }),
        makeRow({ id: "run-b", url: "https://example.com/pricing" }),
      ],
      traces: traceMap({ "run-a": okTrace(), "run-b": okTrace() }),
      thresholds: THRESHOLDS,
      branding: EMPTY_BRANDING,
      generatedAt: GENERATED_AT,
    });
    expect(built.provenance.status).toBe("cancelled");
    expect(built.provenance.total).toBe(20);
    expect(built.notes[0]).toContain("cancelled");
  });
});

/**
 * ROADMAP Phase H security review, H1. The first redaction pass covered the
 * waterfall row and the page URL but MISSED the highlight cards and the error
 * message — and the highlight cards sit at the very top of the document, so the
 * most exposed sink was the unfixed one.
 *
 * This test is deliberately written over the RENDERED HTML rather than per
 * field: the failure mode is "someone adds a fifth place a URL is printed", and
 * only a whole-document assertion catches that.
 */
describe("no page-derived credential survives into the document", () => {
  const SECRET = "https://admin:hunter2@staging.example.com/dash?token=SUPERSECRET123";

  it("strips userinfo and token values from every sink at once", () => {
    const withSecret = (id: string, perf: number) =>
      makeRow({ id, url: SECRET, scores: scores(perf, perf, perf, perf) });
    const failing = makeRow({
      id: "run-err",
      url: SECRET,
      status: "error",
      runs: null,
      fetchTime: null,
      metrics: null,
      hasJsonReport: false,
      scores: scores(null, null, null, null),
      errorMessage: `Chrome could not load ${SECRET} (timeout)`,
    });

    const built = assembleReport({
      batch: makeBatch({ total: 3 }),
      rows: [withSecret("run-a", 95), withSecret("run-b", 20), failing],
      traces: traceMap({}),
      thresholds: THRESHOLDS,
      branding: EMPTY_BRANDING,
      generatedAt: GENERATED_AT,
    });

    // Every field that carries a URL.
    expect(built.summary.best?.url).not.toContain("hunter2");
    expect(built.summary.worst?.url).not.toContain("hunter2");
    expect(built.summary.best?.url).not.toContain("SUPERSECRET123");
    for (const page of built.pages) {
      expect(page.url).not.toContain("hunter2");
      expect(page.url).not.toContain("SUPERSECRET123");
      expect(page.errorMessage ?? "").not.toContain("hunter2");
      expect(page.errorMessage ?? "").not.toContain("SUPERSECRET123");
    }

    // And the document as a whole — the assertion that survives a new sink.
    const html = renderClientReport(built);
    expect(html).not.toContain("hunter2");
    expect(html).not.toContain("SUPERSECRET123");
    // The host is still named: redaction must not blind the report to its subject.
    expect(html).toContain("staging.example.com");
  });
});
