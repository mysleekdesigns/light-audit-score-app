/**
 * Persistence layer round-trip tests (PRD §6 Phase 4).
 *
 * Each test runs against a throwaway SQLite DB + reports dir under a fresh temp
 * directory: we point `LH_DATA_DIR`/`LH_DB_PATH` there, `resetDbForTests()` so
 * the lazy client re-inits against it, and the real drizzle migrations
 * (`./drizzle`) are applied on first access — so this also exercises that the
 * generated migration creates the expected tables.
 *
 * The synthetic LHR is intentionally minimal, so HTML generation
 * (`ReportGenerator`) is expected to be best-effort and may not produce a file;
 * we assert the JSON report (raw LHR) is always written and the row indexed.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDbForTests } from "@/lib/db/client";
import {
  getRunReport,
  listBatches,
  listHistory,
  recordBatch,
  recordFailedRun,
  recordRun,
  updateBatchStatus,
} from "@/lib/db/persistence";
import type { AuditOptions, AuditResult } from "@/lib/lighthouse/types";
import type { AuditJob, Batch } from "@/lib/queue/types";

let tmpDir: string;

const OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance", "accessibility", "best-practices", "seo"],
  runs: 3,
};

function makeBatch(id: string, jobs: AuditJob[]): Batch {
  return {
    id,
    status: "queued",
    options: OPTIONS,
    concurrency: 3,
    jobs,
    counts: {
      total: jobs.length,
      queued: jobs.length,
      running: 0,
      done: 0,
      error: 0,
    },
    createdAt: new Date().toISOString(),
  };
}

function makeJob(id: string, index: number, url: string): AuditJob {
  return {
    id,
    index,
    url,
    status: "queued",
    queuedAt: new Date().toISOString(),
  };
}

function makeResult(url: string): AuditResult {
  return {
    requestedUrl: url,
    finalUrl: `${url}home`,
    options: OPTIONS,
    runs: 3,
    median: {
      scores: {
        performance: 91.4,
        accessibility: 88,
        "best-practices": 100,
        seo: 80,
      },
      metrics: {
        "largest-contentful-paint": {
          numericValue: 800,
          displayValue: "0.8 s",
          score: 1,
        },
        "cumulative-layout-shift": null,
        "total-blocking-time": null,
        "first-contentful-paint": null,
        "speed-index": null,
        interactive: null,
      },
      opportunities: [],
      lhr: { requestedUrl: url, fetchTime: "2026-05-26T00:00:00.000Z" },
    },
    perRunScores: [{ performance: 91 }],
    perRunEnvironments: [
      {
        benchmarkIndex: 1500,
        hostUserAgent: "test",
        throttlingMethod: "simulate",
        cpuSlowdownMultiplier: 4,
      },
    ],
    fetchTime: "2026-05-26T00:00:00.000Z",
    lighthouseVersion: "13.3.0",
    runWarnings: [],
    environment: {
      benchmarkIndex: 1500,
      hostUserAgent: "test",
      throttlingMethod: "simulate",
      cpuSlowdownMultiplier: 4,
    },
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-persist-"));
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

describe("persistence", () => {
  it("records a batch and a successful run, then lists it in history", async () => {
    const job = makeJob("run-1", 0, "https://a.test/");
    const batch = makeBatch("batch-1", [job]);

    recordBatch(batch);
    await recordRun(batch, job, makeResult("https://a.test/"));

    const history = listHistory();
    expect(history).toHaveLength(1);
    const row = history[0];
    expect(row.id).toBe("run-1");
    expect(row.batchId).toBe("batch-1");
    expect(row.url).toBe("https://a.test/");
    expect(row.status).toBe("done");
    expect(row.formFactor).toBe("mobile");
    expect(row.runs).toBe(3);
    // 91.4 rounds to 91; the rest stored verbatim.
    expect(row.scores.performance).toBe(91);
    expect(row.scores.accessibility).toBe(88);
    expect(row.scores["best-practices"]).toBe(100);
    expect(row.scores.seo).toBe(80);
    expect(row.hasJsonReport).toBe(true);
  });

  it("writes the raw LHR JSON report to disk and exposes its path", async () => {
    const job = makeJob("run-json", 0, "https://json.test/");
    const batch = makeBatch("batch-json", [job]);

    recordBatch(batch);
    await recordRun(batch, job, makeResult("https://json.test/"));

    const report = getRunReport("run-json");
    expect(report).toBeDefined();
    expect(report!.jsonPath).not.toBeNull();

    const raw = await fs.readFile(report!.jsonPath!, "utf8");
    const lhr = JSON.parse(raw) as { requestedUrl: string };
    expect(lhr.requestedUrl).toBe("https://json.test/");
  });

  it("records a failed run with the error message and no scores/reports", () => {
    const job: AuditJob = {
      ...makeJob("run-bad", 0, "https://bad.test/"),
      status: "error",
      error: { message: "Chrome launch failed" },
    };
    const batch = makeBatch("batch-bad", [job]);

    recordBatch(batch);
    recordFailedRun(batch, job);

    const history = listHistory();
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("error");
    expect(history[0].errorMessage).toBe("Chrome launch failed");
    expect(history[0].scores.performance).toBeNull();
    expect(history[0].hasJsonReport).toBe(false);
    expect(history[0].hasHtmlReport).toBe(false);

    expect(getRunReport("run-bad")).toBeDefined();
    expect(getRunReport("run-bad")!.jsonPath).toBeNull();
  });

  it("orders history newest-first across multiple runs", async () => {
    const batch = makeBatch("batch-multi", [
      makeJob("r1", 0, "https://1.test/"),
      makeJob("r2", 1, "https://2.test/"),
    ]);
    recordBatch(batch);
    await recordRun(batch, batch.jobs[0], makeResult("https://1.test/"));
    await new Promise((r) => setTimeout(r, 5));
    await recordRun(batch, batch.jobs[1], makeResult("https://2.test/"));

    const history = listHistory();
    expect(history.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("updateBatchStatus does not throw and history survives it", async () => {
    const job = makeJob("run-fin", 0, "https://fin.test/");
    const batch = makeBatch("batch-fin", [job]);
    recordBatch(batch);
    await recordRun(batch, job, makeResult("https://fin.test/"));

    expect(() =>
      updateBatchStatus("batch-fin", {
        status: "completed",
        finishedAt: new Date().toISOString(),
      }),
    ).not.toThrow();

    expect(listHistory()).toHaveLength(1);
  });

  it("getRunReport returns undefined for an unknown run", () => {
    recordBatch(makeBatch("batch-empty", []));
    expect(getRunReport("nope")).toBeUndefined();
  });

  it("parses median Core Web Vitals into the history row", async () => {
    const job = makeJob("run-cwv", 0, "https://cwv.test/");
    const batch = makeBatch("batch-cwv", [job]);
    recordBatch(batch);
    await recordRun(batch, job, makeResult("https://cwv.test/"));

    const [row] = listHistory();
    expect(row.metrics).not.toBeNull();
    expect(row.metrics!["largest-contentful-paint"]).toEqual({
      numericValue: 800,
      displayValue: "0.8 s",
      score: 1,
    });
    expect(row.metrics!["total-blocking-time"]).toBeNull();
  });

  it("leaves metrics null for a failed run", () => {
    const job: AuditJob = {
      ...makeJob("run-nm", 0, "https://nm.test/"),
      status: "error",
      error: { message: "boom" },
    };
    const batch = makeBatch("batch-nm", [job]);
    recordBatch(batch);
    recordFailedRun(batch, job);

    expect(listHistory()[0].metrics).toBeNull();
  });

  it("lists persisted batches newest-first with parsed options", async () => {
    const b1 = makeBatch("b-old", [makeJob("ro", 0, "https://o.test/")]);
    recordBatch(b1);
    await new Promise((r) => setTimeout(r, 5));
    const b2 = makeBatch("b-new", [makeJob("rn", 0, "https://n.test/")]);
    recordBatch(b2);

    const list = listBatches();
    expect(list.map((b) => b.id)).toEqual(["b-new", "b-old"]);
    expect(list[0].options.formFactor).toBe("mobile");
    expect(list[0].options.categories).toContain("performance");
    expect(list[0].total).toBe(1);
    expect(list[0].concurrency).toBe(3);
  });

  it("listBatches returns [] when there are no batches", () => {
    expect(listBatches()).toEqual([]);
  });
});
