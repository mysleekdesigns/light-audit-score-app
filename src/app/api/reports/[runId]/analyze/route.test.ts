/**
 * `POST /api/reports/:runId/analyze` — baseline (regression) wiring tests
 * (ROADMAP Phase E, "Feed the AI").
 *
 * Scope is deliberately narrow: the ENGINE is covered by
 * `src/lib/analysis/diffPrompt.test.ts` and the DIFFERS by
 * `src/lib/reports/diff-*.test.ts`. What no other suite can see is the seam
 * between them — that the route computes a diff from the right pair, hands it to
 * `runAnalysis`, and honours the two rules that make a regression analysis a
 * different artefact from a plain one:
 *
 *  1. it is never REPLAYED from the `(runId, category)` cache, and
 *  2. it is never PERSISTED under that key,
 *
 * because regression-flavoured text stored there would later replay as if it
 * were the plain "explain my SEO score" answer. Both rules are invisible to a
 * type checker and would fail silently in production, so they are asserted here.
 *
 * `runAnalysis` is mocked — this suite is about wiring, spends no tokens, and
 * must not depend on a configured provider. Everything below it (persistence,
 * the report files on disk, the real differs) is real.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDbForTests } from "@/lib/db/client";
import { getAnalysis, saveAnalysis } from "@/lib/db/analyses";
import { recordBatch, recordRun } from "@/lib/db/persistence";
import type { AuditOptions, AuditResult, LighthouseResult } from "@/lib/lighthouse/types";
import type { AuditJob, Batch } from "@/lib/queue/types";
import type { AnalysisResult } from "@/lib/analysis/types";
import type { RunAnalysisArgs } from "@/lib/analysis/runAnalysis";

/** Every `runAnalysis` call the route made, in order. */
const calls: RunAnalysisArgs[] = [];

/**
 * When set, the mocked engine parks on this until it is resolved — which is how
 * a second request can arrive while the first is genuinely in flight. Without
 * it the mock settles synchronously and the in-flight map is always empty.
 */
let held: { promise: Promise<void>; release: () => void } | null = null;

function hold(): void {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  held = { promise, release };
}

vi.mock("@/lib/analysis/runAnalysis", async () => {
  // The route also imports `AnalysisError` from this module for its catch path;
  // keep the real one so a mock never changes error handling.
  const actual = await vi.importActual<typeof import("@/lib/analysis/AnalysisError")>(
    "@/lib/analysis/AnalysisError",
  );
  return {
    AnalysisError: actual.AnalysisError,
    runAnalysis: async (args: RunAnalysisArgs): Promise<AnalysisResult> => {
      calls.push(args);
      if (held) await held.promise;
      return Promise.resolve({
        runId: args.runId,
        category: args.category,
        categoryScore: 82,
        diagnosis: "mocked diagnosis",
        fixes: [],
        sources: [],
        model: "test/mock",
        createdAt: new Date().toISOString(),
      });
    },
  };
});

const { POST } = await import("@/app/api/reports/[runId]/analyze/route");

let tmpDir: string;

const OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance", "seo"],
  runs: 1,
  warmCache: true,
};

const SITE = "https://analyze.test/";

/** A complete `RunEnvironment` — see the note in `makeResult`. */
const ENVIRONMENT = {
  benchmarkIndex: 1500,
  hostUserAgent: "test",
  throttlingMethod: "simulate",
  cpuSlowdownMultiplier: 4,
};

function makeLhr(seoScore: number, metaScore: number): LighthouseResult {
  return {
    requestedUrl: SITE,
    finalUrl: SITE,
    finalDisplayedUrl: SITE,
    fetchTime: "2026-09-06T00:00:00.000Z",
    lighthouseVersion: "13.4.1",
    configSettings: { formFactor: "mobile" },
    categories: {
      seo: {
        id: "seo",
        score: seoScore,
        auditRefs: [{ id: "meta-description", weight: 10 }],
      },
    },
    audits: {
      "meta-description": {
        id: "meta-description",
        title: "Document has a meta description",
        description: "Meta descriptions may be included in search results.",
        score: metaScore,
        scoreDisplayMode: "binary",
      },
    },
  } as unknown as LighthouseResult;
}

function makeResult(lhr: LighthouseResult): AuditResult {
  return {
    requestedUrl: SITE,
    finalUrl: SITE,
    options: OPTIONS,
    runs: 1,
    median: {
      scores: { seo: 82 },
      metrics: {
        "largest-contentful-paint": null,
        "cumulative-layout-shift": null,
        "total-blocking-time": null,
        "first-contentful-paint": null,
        "speed-index": null,
        interactive: null,
      },
      opportunities: [],
      bestPractices: [],
      lhr,
    },
    perRunScores: [{ seo: 82 }],
    // `recordRun` reads `environment.*` unconditionally, and its whole body is
    // log-and-swallow — so a null here silently persists NO row at all, and
    // every assertion below would fail for a reason that has nothing to do with
    // the code under test.
    perRunEnvironments: [ENVIRONMENT],
    fetchTime: "2026-09-06T00:00:00.000Z",
    lighthouseVersion: "13.4.1",
    runWarnings: [],
    environment: ENVIRONMENT,
  } as unknown as AuditResult;
}

async function seedRun(runId: string, lhr: LighthouseResult): Promise<void> {
  const job: AuditJob = {
    id: runId,
    index: 0,
    url: SITE,
    device: "mobile",
    status: "queued",
    queuedAt: new Date().toISOString(),
  };
  const batch: Batch = {
    id: `batch-${runId}`,
    status: "queued",
    device: "mobile",
    source: "local",
    options: OPTIONS,
    concurrency: 1,
    jobs: [job],
    counts: { total: 1, queued: 1, running: 0, done: 0, error: 0, cancelled: 0 },
    createdAt: new Date().toISOString(),
  };
  recordBatch(batch);
  await recordRun(batch, job, makeResult(lhr));
}

/** POST the analyze route and drain its SSE stream to completion. */
async function callPost(
  runId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; events: string }> {
  const res = await POST(
    new Request(`http://localhost/api/reports/${runId}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId }) },
  );
  if (!res.body) return { status: res.status, events: await res.text() };
  return { status: res.status, events: await res.text() };
}

beforeEach(async () => {
  calls.length = 0;
  held = null;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-analyze-route-"));
  process.env.LH_DATA_DIR = tmpDir;
  process.env.LH_DB_PATH = path.join(tmpDir, "test.db");
  resetDbForTests();
  await seedRun("run-base", makeLhr(1, 1));
  await seedRun("run-head", makeLhr(0.82, 0));
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.LH_DATA_DIR;
  delete process.env.LH_DB_PATH;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("POST /api/reports/:runId/analyze — baselineRunId", () => {
  it("computes the diff from the named pair and hands it to runAnalysis", async () => {
    const { status } = await callPost("run-head", {
      category: "seo",
      baselineRunId: "run-base",
    });
    expect(status).toBe(200);

    expect(calls).toHaveLength(1);
    const diff = calls[0].diff;
    expect(diff).toBeTruthy();
    // Both sides carry the DB-round-tripped ids, in the right roles.
    expect(diff?.baseline.runId).toBe("run-base");
    expect(diff?.comparison.runId).toBe("run-head");
    expect(diff?.baseline.scores.seo).toBe(100);
    expect(diff?.comparison.scores.seo).toBe(82);
    // And the audit that moved actually reached the engine.
    expect(diff?.audits.find((a) => a.id === "meta-description")?.status).toBe(
      "regressed",
    );
  });

  it("passes no diff — and so behaves exactly as before — without a baseline", async () => {
    await callPost("run-head", { category: "seo" });
    expect(calls).toHaveLength(1);
    expect(calls[0].diff ?? null).toBeNull();
  });

  it("never persists a regression analysis under the plain (runId, category) key", async () => {
    await callPost("run-head", { category: "seo", baselineRunId: "run-base" });
    // The whole point: a later plain analysis must not replay regression text.
    expect(getAnalysis("run-head", "seo") ?? null).toBeNull();

    // A plain analysis of the same run still persists as it always did.
    await callPost("run-head", { category: "seo" });
    expect(getAnalysis("run-head", "seo")?.diagnosis).toBe("mocked diagnosis");
  });

  it("never replays a cached analysis when a baseline is given", async () => {
    saveAnalysis({
      runId: "run-head",
      category: "seo",
      categoryScore: 82,
      diagnosis: "STALE cached diagnosis",
      fixes: [],
      sources: [],
      model: "test/cached",
      createdAt: new Date().toISOString(),
    });

    // Without a baseline the cache is replayed and the engine is never called.
    await callPost("run-head", { category: "seo" });
    expect(calls).toHaveLength(0);

    // With one, it runs fresh — a regression answer can never come from a cache
    // keyed without the baseline.
    const { events } = await callPost("run-head", {
      category: "seo",
      baselineRunId: "run-base",
    });
    expect(calls).toHaveLength(1);
    expect(events).not.toContain("STALE cached diagnosis");
  });

  it("allows only one analysis per (run, category) at a time, baseline or not", async () => {
    // Phase E security review, L5. This map is the only concurrency bound on an
    // expensive provider process. Widening its key to include the baseline —
    // which I did, so a regression analysis could be its own artefact — removed
    // that bound: switching the baseline picker and re-clicking would claim a
    // fresh slot each time, so N baselines in history meant N concurrent agents.
    hold();
    const release = held!.release;
    try {

    // First analysis: plain, and parked in flight.
    const first = callPost("run-head", { category: "seo" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(1);

    // A baseline-grounded analysis of the SAME run and category is refused
    // while that one is running, even though it is a different artefact.
    const second = await callPost("run-head", {
      category: "seo",
      baselineRunId: "run-base",
    });
    expect(second.status).toBe(409);
    expect(second.events).toContain("analysis_in_progress");
    expect(calls).toHaveLength(1);

    // A different RUN is a genuinely different job and still proceeds — the
    // bound is per (run, category), not a global lock on the analyzer.
    // (Deliberately not "a different category": these fixtures only score seo,
    // so `performance` would be refused as `category_not_run` and the test
    // would pass for the wrong reason.)
    const other = callPost("run-base", { category: "seo" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(2);

    // Released in a finally: an assertion above throwing would otherwise leave
    // a slot claimed in the globalThis-pinned map and cascade into every later
    // test as a spurious 409.
    held!.release();
    await first;
    await other;

    // Once the slot is free the same request succeeds — the guard bounds
    // concurrency, it does not permanently refuse.
    const after = await callPost("run-head", {
      category: "seo",
      baselineRunId: "run-base",
    });
    expect(after.status).toBe(200);
    } finally {
      release();
    }
  });

  it("rejects a self-baseline and an unusable one, without reflecting the input", async () => {
    const same = await callPost("run-head", {
      category: "seo",
      baselineRunId: "run-head",
    });
    expect(same.status).toBe(400);
    expect(same.events).toContain("same_run");

    const marker = "<script>alert(1)</script>";
    const missing = await callPost("run-head", {
      category: "seo",
      baselineRunId: marker,
    });
    expect(missing.status).toBe(404);
    expect(missing.events).toContain("baseline_not_found");
    expect(missing.events).not.toContain(marker);
    expect(calls).toHaveLength(0);
  });
});
