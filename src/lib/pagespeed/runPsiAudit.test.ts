import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditOptions } from "@/lib/lighthouse/types";
import { runPsiAudit } from "@/lib/pagespeed/runPsiAudit";

// Single-run baseline (one PSI API call). Multi-run median is covered separately.
const OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance", "seo"],
  runs: 1,
  warmCache: true,
};

/** A minimal but representative PSI response (lighthouseResult is a real LHR). */
function samplePsiResponse(overrides: Record<string, unknown> = {}) {
  return {
    lighthouseResult: {
      requestedUrl: "https://example.com/",
      finalDisplayedUrl: "https://example.com/",
      fetchTime: "2026-06-02T00:00:00.000Z",
      lighthouseVersion: "13.0.0",
      categories: {
        performance: { score: 0.92 },
        seo: { score: 1 },
      },
      audits: {
        "largest-contentful-paint": {
          numericValue: 1200,
          displayValue: "1.2 s",
          score: 0.95,
        },
      },
      environment: {
        benchmarkIndex: 1500,
        hostUserAgent: "Mozilla/5.0 Chrome/130.0.0.0",
      },
      configSettings: {
        throttlingMethod: "simulate",
        throttling: { cpuSlowdownMultiplier: 4 },
      },
    },
    loadingExperience: {
      overall_category: "AVERAGE",
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: {
          percentile: 2100,
          category: "AVERAGE",
          distributions: [
            { min: 0, max: 2500, proportion: 0.7 },
            { min: 2500, max: 4000, proportion: 0.2 },
            { min: 4000, max: null, proportion: 0.1 },
          ],
        },
      },
    },
    originLoadingExperience: { overall_category: "FAST", metrics: {} },
    analysisUTCTimestamp: "2026-06-02T00:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A PSI response whose lab performance score is `score` (0–1), for median tests. */
function psiResponseWithPerf(score: number) {
  return samplePsiResponse({
    lighthouseResult: {
      requestedUrl: "https://example.com/",
      finalDisplayedUrl: "https://example.com/",
      fetchTime: "2026-06-02T00:00:00.000Z",
      lighthouseVersion: "13.0.0",
      categories: { performance: { score }, seo: { score: 1 } },
      audits: {
        "largest-contentful-paint": {
          numericValue: 1200,
          displayValue: "1.2 s",
          score: 0.95,
        },
      },
      environment: {
        benchmarkIndex: 1500,
        hostUserAgent: "Mozilla/5.0 Chrome/130.0.0.0",
      },
      configSettings: {
        throttlingMethod: "simulate",
        throttling: { cpuSlowdownMultiplier: 4 },
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runPsiAudit", () => {
  it("maps a PSI response to an AuditResult with source=psi and field data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(samplePsiResponse())));

    const result = await runPsiAudit("https://example.com", OPTIONS);

    expect(result.source).toBe("psi");
    expect(result.runs).toBe(1);
    expect(result.finalUrl).toBe("https://example.com/");
    expect(result.median.scores.performance).toBe(92);
    expect(result.median.scores.seo).toBe(100);
    // Lab LHR is preserved for the report endpoint.
    expect(result.median.lhr).toBeDefined();
    // CrUX field data, URL + origin.
    expect(result.field?.url?.overallCategory).toBe("AVERAGE");
    expect(result.field?.url?.metrics.LARGEST_CONTENTFUL_PAINT_MS?.percentile).toBe(2100);
    expect(result.field?.origin?.overallCategory).toBe("FAST");
  });

  it("runs N times and returns the median run (runs: N)", async () => {
    // PSI lab scores vary call-to-call; the engine takes the median of N calls.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(psiResponseWithPerf(0.8)))
      .mockResolvedValueOnce(jsonResponse(psiResponseWithPerf(0.92)))
      .mockResolvedValueOnce(jsonResponse(psiResponseWithPerf(0.95)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runPsiAudit("https://example.com", {
      ...OPTIONS,
      runs: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.runs).toBe(3);
    expect(result.perRunScores).toHaveLength(3);
    expect(result.perRunScores.map((s) => s.performance)).toEqual([80, 92, 95]);
    // These v13-style LHRs have no FCP/TTI audit, so computeMedianRun throws and
    // selectMedianRun falls back to the middle run by index → the 0.92 run.
    expect(result.median.scores.performance).toBe(92);
    // CrUX field data still comes through (from the median run).
    expect(result.field?.url?.overallCategory).toBe("AVERAGE");
  });

  it("returns no field data when CrUX has none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          samplePsiResponse({
            loadingExperience: { metrics: {} },
            originLoadingExperience: { metrics: {} },
          }),
        ),
      ),
    );
    const result = await runPsiAudit("https://example.com", OPTIONS);
    expect(result.source).toBe("psi");
    expect(result.field).toBeUndefined();
  });

  it("retries on 429 then succeeds (exponential backoff)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "rate limited" } }, 429))
      .mockResolvedValueOnce(jsonResponse(samplePsiResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const promise = runPsiAudit("https://example.com", OPTIONS);
    // Let the backoff timer elapse (base 1000ms).
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.source).toBe("psi");
  });

  it("throws a classified error on a non-retriable 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ error: { message: "API key not valid" } }, 400),
      ),
    );
    await expect(runPsiAudit("https://example.com", OPTIONS)).rejects.toThrow(
      /HTTP 400.*API key not valid/,
    );
  });

  it("surfaces a Lighthouse runtimeError as a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          samplePsiResponse({
            lighthouseResult: {
              runtimeError: { code: "FAILED_DOCUMENT_REQUEST" },
            },
          }),
        ),
      ),
    );
    await expect(runPsiAudit("https://example.com", OPTIONS)).rejects.toThrow(
      /could not be loaded/i,
    );
  });
});
