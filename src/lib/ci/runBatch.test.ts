/**
 * Tests for the headless batch seam shared by the CI CLI and the MCP server
 * (ROADMAP Phase F → G).
 *
 * The queue is a fake, but persistence is REAL — a throwaway SQLite DB under a
 * temp dir, the same harness `src/lib/db/persistence.test.ts` uses. That split is
 * the point: what this module promises is "the rows you judge are the rows that
 * were archived", and a fake persistence layer would let that promise pass while
 * being false.
 *
 * Two of these cases are regressions in waiting rather than API checks. A batch
 * that goes terminal *before* a listener could exist must still settle (it used
 * to be possible to hang forever), and a cancelled batch must settle too — a CI
 * job or an agent waiting on a cancellation is worse than one that fails.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isTerminalBatchStatus,
  persistedRows,
  runBatchToCompletion,
  settledJobCount,
} from "@/lib/ci/runBatch";
import { resetDbForTests } from "@/lib/db/client";
import { recordBatch, recordRun } from "@/lib/db/persistence";
import type { AuditOptions, AuditResult } from "@/lib/lighthouse/types";
import type {
  AuditJob,
  AuditQueueApi,
  Batch,
  ProgressEvent,
  ProgressListener,
} from "@/lib/queue/types";

let tmpDir: string;

const OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance", "seo"],
  runs: 1,
  warmCache: true,
};

function makeJob(id: string, index: number, url: string): AuditJob {
  return {
    id,
    index,
    url,
    device: "mobile",
    status: "done",
    queuedAt: new Date().toISOString(),
  };
}

function makeBatch(id: string, jobs: AuditJob[], status: Batch["status"]): Batch {
  return {
    id,
    status,
    device: "mobile",
    source: "local",
    options: OPTIONS,
    concurrency: 1,
    jobs,
    counts: {
      total: jobs.length,
      queued: 0,
      running: 0,
      done: jobs.filter((job) => job.status === "done").length,
      error: jobs.filter((job) => job.status === "error").length,
      cancelled: jobs.filter((job) => job.status === "cancelled").length,
    },
    createdAt: new Date().toISOString(),
  };
}

/** The host environment every persisted run carries (PRD §6 Phase 10). */
const ENVIRONMENT = {
  benchmarkIndex: 1500,
  hostUserAgent: "test",
  throttlingMethod: "simulate" as const,
  cpuSlowdownMultiplier: 4,
};

function makeResult(url: string): AuditResult {
  return {
    requestedUrl: url,
    finalUrl: url,
    options: OPTIONS,
    runs: 1,
    median: {
      scores: { performance: 90, seo: 80 },
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
      lhr: { requestedUrl: url, fetchTime: "2026-09-06T00:00:00.000Z" },
    },
    perRunScores: [{ performance: 90 }],
    perRunEnvironments: [ENVIRONMENT],
    fetchTime: "2026-09-06T00:00:00.000Z",
    lighthouseVersion: "13.4.1",
    runWarnings: [],
    environment: ENVIRONMENT,
  };
}

/**
 * A queue that settles on the next tick, archiving each job as it goes.
 *
 * `settleInline: true` reproduces the one race the real implementation had to
 * defend against — a batch that reaches a terminal status before `createBatch`
 * even returns, so no subscriber can ever see the event.
 */
function fakeQueue(options: {
  jobs: AuditJob[];
  finalStatus: Batch["status"];
  settleInline?: boolean;
  /** Jobs to archive; defaults to every job (the honest case). */
  archive?: AuditJob[];
}): AuditQueueApi & { events: ProgressEvent[] } {
  const listeners = new Map<string, Set<ProgressListener>>();
  let current: Batch | undefined;
  const events: ProgressEvent[] = [];

  const emit = (event: ProgressEvent): void => {
    events.push(event);
    const batchId = "batch" in event ? event.batch.id : event.batchId;
    for (const listener of listeners.get(batchId) ?? []) listener(event);
  };

  const finish = async (): Promise<void> => {
    const settled = makeBatch("batch-1", options.jobs, options.finalStatus);
    for (const job of options.archive ?? options.jobs) {
      if (job.status === "done") {
        await recordRun(settled, job, makeResult(job.url));
      }
    }
    current = settled;
    emit(
      options.finalStatus === "cancelled"
        ? { type: "batch-cancelled", batch: settled }
        : { type: "batch-completed", batch: settled },
    );
  };

  return {
    events,
    concurrency: 1,
    createBatch: () => {
      current = makeBatch("batch-1", options.jobs, "queued");
      recordBatch(current);
      if (options.settleInline) {
        // Terminal before anyone could subscribe: the snapshot re-check in
        // `awaitBatchSettlement` is the only thing that stops this hanging.
        const settled = makeBatch("batch-1", options.jobs, options.finalStatus);
        for (const job of options.jobs) {
          if (job.status === "done") void recordRun(settled, job, makeResult(job.url));
        }
        current = settled;
      } else {
        setTimeout(() => void finish(), 0);
      }
      return current;
    },
    getBatch: () => current,
    cancelBatch: () => current,
    getJobResult: () => undefined,
    forgetJobResults: () => {},
    subscribe: (batchId, listener) => {
      const set = listeners.get(batchId) ?? new Set<ProgressListener>();
      set.add(listener);
      listeners.set(batchId, set);
      return () => set.delete(listener);
    },
  } as AuditQueueApi & { events: ProgressEvent[] };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-runbatch-"));
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

describe("isTerminalBatchStatus", () => {
  it("counts every way a batch can stop, including the unhappy ones", () => {
    expect(isTerminalBatchStatus("completed")).toBe(true);
    expect(isTerminalBatchStatus("completed_with_errors")).toBe(true);
    expect(isTerminalBatchStatus("cancelled")).toBe(true);
    expect(isTerminalBatchStatus("queued")).toBe(false);
    expect(isTerminalBatchStatus("running")).toBe(false);
  });
});

describe("runBatchToCompletion", () => {
  it("returns the archived rows in batch order, not in write order", async () => {
    // Rows come back from `listHistory()` newest-first, so a batch whose second
    // page finished first would report its pages reversed — and a CI report that
    // lists page 2 as page 1 is a report nobody can act on.
    const jobs = [
      makeJob("run-a", 0, "https://a.test/"),
      makeJob("run-b", 1, "https://b.test/"),
    ];
    const queue = fakeQueue({ jobs, finalStatus: "completed" });

    const outcome = await runBatchToCompletion(queue, {
      urls: ["https://a.test/", "https://b.test/"],
      device: "mobile",
      options: OPTIONS,
    });

    expect(outcome.batch.status).toBe("completed");
    expect(outcome.rows.map((row) => row.id)).toEqual(["run-a", "run-b"]);
    expect(outcome.settledJobs).toBe(2);
    expect(Date.parse(outcome.finishedAt)).toBeGreaterThanOrEqual(
      Date.parse(outcome.startedAt),
    );
  });

  it("hands the fresh batch to onBatchCreated before it waits", async () => {
    // The CLI's Ctrl-C handler is installed from this callback; without it there
    // is no id to cancel until the batch has already finished.
    const jobs = [makeJob("run-a", 0, "https://a.test/")];
    const queue = fakeQueue({ jobs, finalStatus: "completed" });
    let seen: string | null = null;

    await runBatchToCompletion(queue, {
      urls: ["https://a.test/"],
      device: "mobile",
      options: OPTIONS,
      onBatchCreated: (batch) => {
        seen = batch.id;
      },
    });

    expect(seen).toBe("batch-1");
  });

  it("settles a batch that went terminal before any listener existed", async () => {
    const jobs = [makeJob("run-a", 0, "https://a.test/")];
    const queue = fakeQueue({ jobs, finalStatus: "completed", settleInline: true });

    const outcome = await runBatchToCompletion(queue, {
      urls: ["https://a.test/"],
      device: "mobile",
      options: OPTIONS,
    });

    expect(outcome.batch.status).toBe("completed");
  });

  it("settles a cancelled batch rather than waiting forever", async () => {
    const jobs = [makeJob("run-a", 0, "https://a.test/")];
    const queue = fakeQueue({ jobs, finalStatus: "cancelled" });

    const outcome = await runBatchToCompletion(queue, {
      urls: ["https://a.test/"],
      device: "mobile",
      options: OPTIONS,
    });

    expect(outcome.batch.status).toBe("cancelled");
  });

  it("forwards progress events to onEvent, and stays silent without one", async () => {
    const jobs = [makeJob("run-a", 0, "https://a.test/")];
    const seen: ProgressEvent[] = [];
    await runBatchToCompletion(fakeQueue({ jobs, finalStatus: "completed" }), {
      urls: ["https://a.test/"],
      device: "mobile",
      options: OPTIONS,
      onEvent: (event) => seen.push(event),
    });
    expect(seen.map((event) => event.type)).toContain("batch-completed");

    // No sink is the MCP server's case: the same path must run without one.
    await expect(
      runBatchToCompletion(fakeQueue({ jobs, finalStatus: "completed" }), {
        urls: ["https://a.test/"],
        device: "mobile",
        options: OPTIONS,
      }),
    ).resolves.toMatchObject({ settledJobs: 1 });
  });

  it("reports a short archive rather than hiding it", async () => {
    // The backstop the CLI turns into a hard failure: `settledJobs` counts the
    // jobs that finished and `rows` counts what reached SQLite, so a caller can
    // see the difference. Silently judging fewer pages than were run is the
    // worst failure this tool has — it passes a build nobody checked.
    const jobs = [
      makeJob("run-a", 0, "https://a.test/"),
      makeJob("run-b", 1, "https://b.test/"),
    ];
    const queue = fakeQueue({
      jobs,
      finalStatus: "completed",
      archive: [jobs[0]],
    });

    const outcome = await runBatchToCompletion(queue, {
      urls: ["https://a.test/", "https://b.test/"],
      device: "mobile",
      options: OPTIONS,
    });

    expect(outcome.settledJobs).toBe(2);
    expect(outcome.rows).toHaveLength(1);
  });
});

describe("persistedRows / settledJobCount", () => {
  it("counts only settled jobs, and ignores rows from other batches", async () => {
    const jobs = [
      makeJob("run-a", 0, "https://a.test/"),
      { ...makeJob("run-b", 1, "https://b.test/"), status: "cancelled" as const },
    ];
    const batch = makeBatch("batch-1", jobs, "cancelled");
    recordBatch(batch);
    await recordRun(batch, jobs[0], makeResult("https://a.test/"));

    const other = makeBatch("batch-2", [makeJob("run-c", 0, "https://c.test/")], "completed");
    recordBatch(other);
    await recordRun(other, other.jobs[0], makeResult("https://c.test/"));

    expect(settledJobCount(batch)).toBe(1);
    expect(persistedRows(batch).map((row) => row.id)).toEqual(["run-a"]);
  });
});
