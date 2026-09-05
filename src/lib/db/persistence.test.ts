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

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAnalysis, saveAnalysis } from "@/lib/db/analyses";
import { getDb, resetDbForTests } from "@/lib/db/client";
import { reportJsonPath } from "@/lib/db/paths";
import {
  deleteBatch,
  getRunReport,
  listBatches,
  listHistory,
  reconstructBatch,
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
  warmCache: true,
};

function makeBatch(id: string, jobs: AuditJob[]): Batch {
  return {
    id,
    status: "queued",
    device: OPTIONS.formFactor,
    source: "local",
    options: OPTIONS,
    concurrency: 3,
    jobs,
    counts: {
      total: jobs.length,
      queued: jobs.length,
      running: 0,
      done: 0,
      error: 0,
      cancelled: 0,
    },
    createdAt: new Date().toISOString(),
  };
}

function makeJob(
  id: string,
  index: number,
  url: string,
  device: AuditJob["device"] = "mobile",
): AuditJob {
  return {
    id,
    index,
    url,
    device,
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
      bestPractices: [],
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

/**
 * A result that also carries Lighthouse 13.3's fifth category (Agentic
 * Browsing). Pass `null` for the "category selected but unscored" case; the
 * shared {@link makeResult} covers the "category never selected" one.
 */
function makeAgenticResult(url: string, score: number | null): AuditResult {
  const base = makeResult(url);
  return {
    ...base,
    options: {
      ...OPTIONS,
      categories: [...OPTIONS.categories, "agentic-browsing"],
    },
    median: {
      ...base.median,
      scores: { ...base.median.scores, "agentic-browsing": score },
    },
  };
}

/**
 * Insert a `runs` row the way a pre-0007 build did: the INSERT never mentions
 * `score_agentic_browsing`, so the column added by the migration holds SQL NULL.
 * Proves the new column is nullable with no default (a `NOT NULL DEFAULT 0`
 * would surface a legacy run as a hard 0 for the fifth category).
 */
function insertLegacyRow(id: string, batchId: string, url: string): void {
  getDb().run(sql`
    INSERT INTO runs (
      id, batch_id, idx, url, final_url, status, source, form_factor,
      throttling, runs, lighthouse_version,
      score_performance, score_accessibility, score_best_practices, score_seo,
      options, metrics, report_json, fetch_time, created_at
    ) VALUES (
      ${id}, ${batchId}, 0, ${url}, ${url}, 'done', 'local', 'mobile',
      'simulated', 3, '13.2.0',
      88, 77, 66, 55,
      ${JSON.stringify(OPTIONS)}, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z'
    )
  `);
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

  it("records a failed run's form factor from job.device, not batch.options.formFactor", () => {
    // A "both" batch fans each URL out into a mobile + a desktop job; the
    // batch's representative options.formFactor is mobile (the first resolved
    // form factor). A failed DESKTOP job must still record form_factor=desktop.
    const desktopJob: AuditJob = {
      ...makeJob("run-both-desktop", 1, "https://both.test/", "desktop"),
      status: "error",
      error: { message: "Chrome launch failed" },
    };
    const batch = makeBatch("batch-both", [desktopJob]);
    // Sanity: the batch-level options pin mobile, so this proves the row reads
    // the per-job device rather than the batch representative.
    expect(batch.options.formFactor).toBe("mobile");

    recordBatch(batch);
    recordFailedRun(batch, desktopJob);

    const [row] = listHistory();
    expect(row.id).toBe("run-both-desktop");
    expect(row.status).toBe("error");
    expect(row.formFactor).toBe("desktop");
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

  it("persists and reads back a re-run's priorBatchId (null for fresh batches)", () => {
    // PRD §6 Phase 13: a fresh batch records no lineage; a re-run records the source.
    const fresh = makeBatch("b-fresh", [makeJob("rf", 0, "https://f.test/")]);
    recordBatch(fresh);
    const rerun: Batch = {
      ...makeBatch("b-rerun", [makeJob("rr", 0, "https://f.test/")]),
      priorBatchId: "b-fresh",
    };
    recordBatch(rerun);

    const byId = new Map(listBatches().map((b) => [b.id, b]));
    expect(byId.get("b-fresh")!.priorBatchId).toBeNull();
    expect(byId.get("b-rerun")!.priorBatchId).toBe("b-fresh");
  });

  it("exposes the run's resolved options on each HistoryRow (for single-page re-run)", async () => {
    // PRD §6 Phase 13: a History row carries its full AuditOptions so a re-run can
    // reproduce the page with the same categories / throttling, not just its device.
    const job = makeJob("r-opts", 0, "https://opts.test/");
    const batch = makeBatch("b-opts", [job]);
    recordBatch(batch);
    await recordRun(batch, job, makeResult("https://opts.test/"));

    const row = listHistory().find((r) => r.id === "r-opts")!;
    expect(row.options.categories).toEqual(OPTIONS.categories);
    expect(row.options.throttling).toBe("simulated");
    expect(row.options.runs).toBe(3);
  });
});

describe("agentic-browsing score (Lighthouse 13.3's fifth category)", () => {
  it("round-trips a scored run through the score_agentic_browsing column", async () => {
    const job = makeJob("ag-scored", 0, "https://agent.test/");
    const batch = makeBatch("batch-ag", [job]);
    recordBatch(batch);
    await recordRun(batch, job, makeAgenticResult("https://agent.test/", 66.6));

    const [row] = listHistory();
    // Rounded to the int column exactly like the other four.
    expect(row.scores["agentic-browsing"]).toBe(67);
    // The pre-existing four are unaffected by the widening.
    expect(row.scores.performance).toBe(91);
    expect(row.scores.seo).toBe(80);
  });

  it("reads back null — never 0 — for a run that didn't select the category", async () => {
    // makeResult()'s median carries only the four weighted categories, which is
    // what a run with `categories: [performance, a11y, best-practices, seo]`
    // produces. The fifth score must be missing, not zero.
    const job = makeJob("ag-absent", 0, "https://absent.test/");
    const batch = makeBatch("batch-ag-absent", [job]);
    recordBatch(batch);
    await recordRun(batch, job, makeResult("https://absent.test/"));

    const [row] = listHistory();
    expect(row.scores["agentic-browsing"]).toBeNull();
    expect(row.scores["agentic-browsing"]).not.toBe(0);
  });

  it("reads back null for a category that ran but produced no score", async () => {
    const job = makeJob("ag-null", 0, "https://null.test/");
    const batch = makeBatch("batch-ag-null", [job]);
    recordBatch(batch);
    await recordRun(batch, job, makeAgenticResult("https://null.test/", null));

    const [row] = listHistory();
    expect(row.scores["agentic-browsing"]).toBeNull();
    expect(row.scores["agentic-browsing"]).not.toBe(0);
  });

  it("leaves the fifth score null on a failed run, like the other four", () => {
    const job: AuditJob = {
      ...makeJob("ag-bad", 0, "https://bad.test/"),
      status: "error",
      error: { message: "Chrome launch failed" },
    };
    const batch = makeBatch("batch-ag-bad", [job]);
    recordBatch(batch);
    recordFailedRun(batch, job);

    const [row] = listHistory();
    expect(row.scores["agentic-browsing"]).toBeNull();
    expect(row.scores.performance).toBeNull();
  });

  it("degrades a legacy row (written before the 0007 migration) to a null score", () => {
    // The migration self-heals on first DB access, so an old row gains the
    // column with SQL NULL. History must show it as unscored, keeping the four
    // scores the row *does* carry intact.
    const batch = makeBatch("batch-legacy", []);
    recordBatch(batch);
    insertLegacyRow("legacy-run", "batch-legacy", "https://legacy.test/");

    const [row] = listHistory();
    expect(row.id).toBe("legacy-run");
    expect(row.scores.performance).toBe(88);
    expect(row.scores.accessibility).toBe(77);
    expect(row.scores["best-practices"]).toBe(66);
    expect(row.scores.seo).toBe(55);
    expect(row.scores["agentic-browsing"]).toBeNull();
    expect(row.scores["agentic-browsing"]).not.toBe(0);
  });

  it("reconstructs the fifth score (and its legacy null) from the runs table", async () => {
    const job = makeJob("ag-rb", 0, "https://agent.test/");
    const batch = makeBatch("batch-ag-rb", [job]);
    recordBatch(batch);
    await recordRun(batch, job, makeAgenticResult("https://agent.test/", 50));
    insertLegacyRow("ag-rb-legacy", "batch-ag-rb", "https://legacy.test/");
    updateBatchStatus("batch-ag-rb", {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });

    const restored = reconstructBatch("batch-ag-rb")!;
    const byId = new Map(restored.jobs.map((j) => [j.id, j]));
    expect(byId.get("ag-rb")!.result!.median.scores["agentic-browsing"]).toBe(50);
    const legacy = byId.get("ag-rb-legacy")!.result!.median.scores;
    expect(legacy["agentic-browsing"]).toBeNull();
    expect(legacy["agentic-browsing"]).not.toBe(0);
    expect(legacy.performance).toBe(88);
  });
});

describe("reconstructBatch (PRD §6 Phase 15)", () => {
  it("round-trips a completed batch from the DB after a queue miss", async () => {
    // Mirror what the queue persists for a finished 2-URL batch: the batch row,
    // a done run per URL, then the terminal status.
    const j1 = makeJob("rb-1", 0, "https://a.test/");
    const j2 = makeJob("rb-2", 1, "https://b.test/");
    const batch = makeBatch("rb-batch", [j1, j2]);
    recordBatch(batch);
    await recordRun(batch, j1, makeResult("https://a.test/"));
    await recordRun(batch, j2, makeResult("https://b.test/"));
    updateBatchStatus("rb-batch", {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });

    const restored = reconstructBatch("rb-batch");
    expect(restored).toBeDefined();
    expect(restored!.id).toBe("rb-batch");
    expect(restored!.status).toBe("completed");
    expect(restored!.device).toBe("mobile");
    expect(restored!.source).toBe("local");
    expect(restored!.options.categories).toEqual(OPTIONS.categories);
    expect(restored!.concurrency).toBe(3);

    // Jobs come back in idx order, mapped to done with reconstructed lite results.
    expect(restored!.jobs.map((j) => j.id)).toEqual(["rb-1", "rb-2"]);
    const [a] = restored!.jobs;
    expect(a.status).toBe("done");
    expect(a.url).toBe("https://a.test/");
    expect(a.result).toBeDefined();
    expect(a.result!.median.scores.performance).toBe(91); // 91.4 persisted as 91
    expect(a.result!.median.scores.seo).toBe(80);
    expect(a.result!.median.metrics["largest-contentful-paint"]).toEqual({
      numericValue: 800,
      displayValue: "0.8 s",
      score: 1,
    });
    // Lossy-by-design: the per-run spread isn't persisted as columns.
    expect(a.result!.perRunScores).toEqual([]);
    expect(a.result!.perRunEnvironments).toEqual([]);
    // The median environment survives via the Phase-10 columns.
    expect(a.result!.environment.benchmarkIndex).toBe(1500);

    // Counts are recomputed from the reconstructed (settled) jobs.
    expect(restored!.counts).toMatchObject({ total: 2, done: 2, error: 0 });
  });

  it("returns undefined for an unknown batch id", () => {
    expect(reconstructBatch("does-not-exist")).toBeUndefined();
  });

  it("coerces a non-terminal status to cancelled when no runs settled (interrupted mid-run)", () => {
    // A batch whose process died mid-run persists a non-terminal status (here
    // `running`) with zero settled runs. The live queue no longer owns it, so it
    // can never finalize on its own — reconstructBatch must present it terminal or
    // the audit stream would spin on "Running…" forever. With nothing settled it's
    // an interrupted batch with no results → cancelled.
    const batch = makeBatch("rb-stuck", [
      makeJob("rb-s1", 0, "https://a.test/"),
      makeJob("rb-s2", 1, "https://b.test/"),
    ]);
    recordBatch(batch); // persisted as "queued" with total 2
    updateBatchStatus("rb-stuck", {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    // No recordRun — the process died before any job settled.

    const restored = reconstructBatch("rb-stuck")!;
    expect(restored.status).toBe("cancelled");
    expect(restored.jobs).toEqual([]);
    expect(restored.counts).toMatchObject({ total: 0, done: 0, error: 0 });
  });

  it("coerces a non-terminal status to completed from the runs that did settle", async () => {
    // Some runs settled before the interruption; the persisted status is still
    // non-terminal. The surviving runs are all `done` → completed (mirrors how the
    // live queue's maybeFinalizeBatch would have finalized that same job set).
    const j1 = makeJob("rb-p1", 0, "https://a.test/");
    const batch = makeBatch("rb-partial", [
      j1,
      makeJob("rb-p2", 1, "https://b.test/"),
    ]);
    recordBatch(batch);
    await recordRun(batch, j1, makeResult("https://a.test/"));
    updateBatchStatus("rb-partial", {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    // rb-p2 never settled (no recordRun), so its run row is absent.

    const restored = reconstructBatch("rb-partial")!;
    expect(restored.status).toBe("completed");
    expect(restored.jobs.map((j) => j.id)).toEqual(["rb-p1"]);
    expect(restored.counts).toMatchObject({ total: 1, done: 1, error: 0 });
  });

  it("reconstructs a failed run as an error job carrying its message", () => {
    const bad: AuditJob = {
      ...makeJob("rb-bad", 0, "https://bad.test/"),
      status: "error",
      error: { message: "Chrome launch failed" },
    };
    const batch = makeBatch("rb-batch-bad", [bad]);
    recordBatch(batch);
    recordFailedRun(batch, bad);
    updateBatchStatus("rb-batch-bad", {
      status: "completed_with_errors",
      finishedAt: new Date().toISOString(),
    });

    const restored = reconstructBatch("rb-batch-bad")!;
    expect(restored.status).toBe("completed_with_errors");
    const [job] = restored.jobs;
    expect(job.status).toBe("error");
    expect(job.result).toBeUndefined();
    expect(job.error).toEqual({ message: "Chrome launch failed" });
    expect(restored.counts).toMatchObject({ total: 1, done: 0, error: 1 });
  });

  it("derives device 'both' when a URL was audited on mobile and desktop", async () => {
    const mob = makeJob("rb-mob", 0, "https://both.test/", "mobile");
    const desk = makeJob("rb-desk", 1, "https://both.test/", "desktop");
    const batch = makeBatch("rb-both", [mob, desk]);
    recordBatch(batch);
    await recordRun(batch, mob, makeResult("https://both.test/"));
    // The worker echoes per-job options, so the desktop run persists
    // formFactor=desktop (recordRun reads result.options.formFactor).
    const deskResult = {
      ...makeResult("https://both.test/"),
      options: { ...OPTIONS, formFactor: "desktop" as const },
    };
    await recordRun(batch, desk, deskResult);
    updateBatchStatus("rb-both", {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });

    const restored = reconstructBatch("rb-both")!;
    expect(restored.device).toBe("both");
    expect(restored.jobs.map((j) => j.device)).toEqual(["mobile", "desktop"]);
  });
});

describe("deleteBatch (PRD §6 Phase 16)", () => {
  it("removes the batch's runs, report files, analyses, and the batch row", async () => {
    const j1 = makeJob("db-1", 0, "https://a.test/");
    const j2 = makeJob("db-2", 1, "https://b.test/");
    const batch = makeBatch("batch-del", [j1, j2]);
    recordBatch(batch);
    await recordRun(batch, j1, makeResult("https://a.test/"));
    await recordRun(batch, j2, makeResult("https://b.test/"));
    // Seed an AI analysis on one run so we can assert it's cascaded away too.
    saveAnalysis({
      runId: "db-1",
      category: "performance",
      categoryScore: 91,
      diagnosis: "slow LCP",
      fixes: [],
      sources: [],
      model: "test-model",
      createdAt: new Date().toISOString(),
    });

    // Pre-conditions: both report files on disk, analysis present, rows indexed.
    await expect(fs.access(reportJsonPath("db-1"))).resolves.toBeUndefined();
    await expect(fs.access(reportJsonPath("db-2"))).resolves.toBeUndefined();
    expect(getAnalysis("db-1", "performance")).not.toBeNull();

    expect(await deleteBatch("batch-del")).toBe(true);

    // Runs gone from history, batch gone from the batch list.
    expect(listHistory()).toEqual([]);
    expect(listBatches().some((b) => b.id === "batch-del")).toBe(false);
    // Report files removed from disk.
    await expect(fs.access(reportJsonPath("db-1"))).rejects.toThrow();
    await expect(fs.access(reportJsonPath("db-2"))).rejects.toThrow();
    // Child analysis cascaded away with the run.
    expect(getAnalysis("db-1", "performance")).toBeNull();
  });

  it("returns false for an unknown batch id", async () => {
    expect(await deleteBatch("does-not-exist")).toBe(false);
  });
});
