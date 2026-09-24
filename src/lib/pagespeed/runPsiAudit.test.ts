import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditOptions } from "@/lib/lighthouse/types";
import { resetPsiRateLimiter } from "@/lib/pagespeed/rateLimiter";
import { PsiQuotaError, runPsiAudit } from "@/lib/pagespeed/runPsiAudit";

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

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** Google's real 429 body for an exhausted per-minute quota. */
const QUOTA_429 = {
  error: {
    message:
      "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute' of service 'pagespeedonline.googleapis.com' for consumer 'project_number:123'.",
  },
};

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

beforeEach(() => {
  // The limiter is process-wide: drop any cooldown a previous test left behind.
  resetPsiRateLimiter();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

  it("retries a 5xx after the short transient backoff", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "backend" } }, 503))
      .mockResolvedValueOnce(jsonResponse(samplePsiResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const promise = runPsiAudit("https://example.com", OPTIONS);
    // Let the transient backoff (base 1000ms) elapse.
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.source).toBe("psi");
  });

  it("waits for the quota window (15s, not 1s) before retrying a 429", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(QUOTA_429, 429))
      .mockResolvedValueOnce(jsonResponse(samplePsiResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const promise = runPsiAudit("https://example.com", OPTIONS);
    // The old 1–2s backoff would already have retried here; the window hasn't rolled.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 15s quota backoff (+ up to 250ms jitter).
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.source).toBe("psi");
  });

  it("honours Google's Retry-After header on a 429", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(QUOTA_429, 429, { "retry-after": "3" }))
      .mockResolvedValueOnce(jsonResponse(samplePsiResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const promise = runPsiAudit("https://example.com", OPTIONS);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.source).toBe("psi");
  });

  it("puts every concurrent job on cooldown after one 429", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(QUOTA_429, 429))
      // A fresh Response per call — a body can only be read once.
      .mockImplementation(async () => jsonResponse(samplePsiResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const first = runPsiAudit("https://example.com/a", OPTIONS);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second job starting 1s later must not fire into the exhausted window.
    const second = runPsiAudit("https://example.com/b", OPTIONS);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cooldown (15s from the 429) elapses → both go.
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after five 429s with a quota-specific error", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PAGESPEED_API_KEY", "test-key");
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse(QUOTA_429, 429));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = runPsiAudit("https://example.com", OPTIONS).catch((err) => err);
    // 15s + 30s + 60s + 60s of waits (+ jitter).
    await vi.advanceTimersByTimeAsync(200_000);
    const err = (await outcome) as Error;

    expect(err).toBeInstanceOf(PsiQuotaError);
    expect(err.message).toMatch(/per-minute quota/);
    expect(err.message).toMatch(/5 attempts over 165s/);
    expect(err.message).toMatch(/Queries per minute/);
    expect(err.message).toMatch(/PAGESPEED_REQUESTS_PER_MINUTE/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("points a keyless caller at PAGESPEED_API_KEY when the quota is exhausted", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PAGESPEED_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse(QUOTA_429, 429));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = runPsiAudit("https://example.com", OPTIONS).catch((err) => err);
    await vi.advanceTimersByTimeAsync(200_000);
    const err = (await outcome) as Error;

    expect(err).toBeInstanceOf(PsiQuotaError);
    expect(err.message).toMatch(/Set PAGESPEED_API_KEY/);
    expect(err.message).not.toMatch(/PAGESPEED_REQUESTS_PER_MINUTE/);
  });

  it("keeps completed runs when a later run is quota-rejected", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(psiResponseWithPerf(0.8)))
      .mockResolvedValueOnce(jsonResponse(psiResponseWithPerf(0.92)))
      .mockImplementation(async () => jsonResponse(QUOTA_429, 429));
    vi.stubGlobal("fetch", fetchMock);

    const promise = runPsiAudit("https://example.com", { ...OPTIONS, runs: 3 });
    await vi.advanceTimersByTimeAsync(200_000);
    const result = await promise;

    // 2 good runs + 5 rejected attempts for the third.
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(result.runs).toBe(2);
    expect(result.perRunScores.map((s) => s.performance)).toEqual([80, 92]);
    expect(result.runWarnings).toEqual([
      expect.stringMatching(/completed 2 of 3 runs .* on run 3/),
    ]);
  });

  it("still fails the job when the first run is quota-rejected", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse(QUOTA_429, 429));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = runPsiAudit("https://example.com", { ...OPTIONS, runs: 3 }).catch(
      (err) => err,
    );
    await vi.advanceTimersByTimeAsync(200_000);

    expect(await outcome).toBeInstanceOf(PsiQuotaError);
    expect(fetchMock).toHaveBeenCalledTimes(5);
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
