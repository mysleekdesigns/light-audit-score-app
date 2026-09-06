/**
 * Deletion prunes the queue's retained results (ROADMAP Phase E security review,
 * M1).
 *
 * The queue keeps every finished run's heavy, LHR-bearing `AuditResult` so the
 * report routes can serve a run that has not been persisted yet. Nothing pruned
 * that map, so a run deleted from the archive — or a whole "Clear history" — kept
 * answering `GET /api/reports/:runId/trace` and `…/diff` from memory for the life
 * of the process, with the audited URL, every subresource URL the page fetched
 * and the filmstrip screenshots. Someone clearing history to remove the record of
 * what they audited did not get that. It is the same shape as Phase C's M2, which
 * left audited URLs behind in `schedule_alerts`.
 *
 * This file covers the WIRING — that the persistence layer actually asks the
 * queue to forget. The queue's own semantics (targeted vs wholesale, idempotent,
 * unknown id is not an error) are covered in `@/lib/queue/AuditQueue.test.ts`,
 * and the route's refusal to serve a deleted run in the two report route tests.
 *
 * The queue module is mocked, which is the point: `deleteRun` reaches it through
 * a LAZY import (a static one would be a cycle — `AuditQueue` imports
 * persistence), and a lazy import is exactly the kind of call that can be dropped
 * in a refactor without any type error to catch it.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const forgetQueuedResults = vi.fn();

vi.mock("@/lib/queue/AuditQueue", () => ({
  forgetQueuedResults,
  // `persistence.ts` only needs the one export, but the module is imported
  // elsewhere in the graph, so keep the singleton accessor present and inert.
  getAuditQueue: () => ({ getJobResult: () => undefined }),
}));

const { resetDbForTests } = await import("@/lib/db/client");
const { clearHistory, deleteRun, recordBatch, recordRun } = await import(
  "@/lib/db/persistence"
);

type AuditOptions = import("@/lib/lighthouse/types").AuditOptions;
type AuditResult = import("@/lib/lighthouse/types").AuditResult;
type AuditJob = import("@/lib/queue/types").AuditJob;
type Batch = import("@/lib/queue/types").Batch;

let tmpDir: string;

const OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance"],
  runs: 1,
  warmCache: true,
};

const ENVIRONMENT = {
  benchmarkIndex: 1500,
  hostUserAgent: "test",
  throttlingMethod: "simulate",
  cpuSlowdownMultiplier: 4,
};

async function seedRun(runId: string, url: string): Promise<void> {
  const job: AuditJob = {
    id: runId,
    index: 0,
    url,
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
  const result = {
    requestedUrl: url,
    finalUrl: url,
    options: OPTIONS,
    runs: 1,
    median: {
      scores: { performance: 90 },
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
      lhr: { requestedUrl: url, audits: {}, categories: {} },
    },
    perRunScores: [{ performance: 90 }],
    perRunEnvironments: [ENVIRONMENT],
    fetchTime: new Date().toISOString(),
    lighthouseVersion: "13.4.1",
    runWarnings: [],
    environment: ENVIRONMENT,
  } as unknown as AuditResult;
  await recordRun(batch, job, result);
}

beforeEach(async () => {
  forgetQueuedResults.mockClear();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-prune-"));
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

describe("deletion prunes the queue's retained results", () => {
  it("deleteRun forgets exactly the run it deleted", async () => {
    await seedRun("run-a", "https://a.test/");
    await seedRun("run-b", "https://b.test/");

    expect(await deleteRun("run-a")).toBe(true);

    expect(forgetQueuedResults).toHaveBeenCalledTimes(1);
    // Targeted, not wholesale: deleting one run must not drop the in-memory
    // result of a run that is still in the archive.
    expect(forgetQueuedResults).toHaveBeenCalledWith("run-a");
  });

  it("clearHistory forgets everything", async () => {
    await seedRun("run-a", "https://a.test/");
    await seedRun("run-b", "https://b.test/");

    await clearHistory();

    expect(forgetQueuedResults).toHaveBeenCalledTimes(1);
    // No argument means "all of them" — the whole archive just went.
    expect(forgetQueuedResults).toHaveBeenCalledWith(undefined);
  });

  it("does not prune when there was no row to delete", async () => {
    expect(await deleteRun("never-existed")).toBe(false);
    expect(forgetQueuedResults).not.toHaveBeenCalled();
  });

  it("still deletes when pruning throws", async () => {
    await seedRun("run-a", "https://a.test/");
    forgetQueuedResults.mockImplementationOnce(() => {
      throw new Error("queue exploded");
    });

    // Log-and-swallow, like the rest of the persistence layer: failing to prune
    // a cache must never turn a successful deletion into a failed one, or the
    // user is told their data is still there when the row is already gone.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await deleteRun("run-a")).toBe(true);
    warn.mockRestore();
  });
});
