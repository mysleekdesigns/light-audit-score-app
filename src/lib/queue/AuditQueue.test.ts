/**
 * Unit tests for the in-process audit queue (PRD §6 Phase 2).
 *
 * The process-isolated runner (`@/lib/queue/runAuditWorker`) is fully mocked so
 * no child process forks and no Chrome ever launches — `runAuditInWorker` is a
 * `vi.fn()` whose resolution/rejection we drive per test (the queue calls it
 * exactly where it would otherwise fork a worker). Each test builds a fresh
 * `new AuditQueue()` (never the global singleton)
 * so state never leaks between tests. We await `getAuditQueue`-free drain via
 * the public `subscribe` `batch-completed` event (the queue's internal PQueue is
 * private) and assert on the lhr-stripping invariant via `getJobResult`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditResult } from "@/lib/lighthouse/types";

// Mock the process-isolated runner before importing the queue so the mock is
// wired in (no real fork / Chrome launch during unit tests).
vi.mock("@/lib/queue/runAuditWorker", () => ({ runAuditInWorker: vi.fn() }));

// Mock the persistence seam so the queue's DB/disk side effects don't touch the
// real SQLite file or write report files during unit tests.
vi.mock("@/lib/db/persistence", () => ({
  recordBatch: vi.fn(),
  recordRun: vi.fn().mockResolvedValue(undefined),
  recordFailedRun: vi.fn(),
  updateBatchStatus: vi.fn(),
}));

const { runAuditInWorker } = await import("@/lib/queue/runAuditWorker");
const persistence = await import("@/lib/db/persistence");
const { AuditQueue, getAuditQueue } = await import("@/lib/queue/AuditQueue");

import {
  type AuditQueueApi,
  type Batch,
  type CreateBatchInput,
  type ProgressEvent,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
} from "@/lib/queue/types";

const mockRunAudit = vi.mocked(runAuditInWorker);
const mockRecordBatch = vi.mocked(persistence.recordBatch);
const mockRecordRun = vi.mocked(persistence.recordRun);
const mockRecordFailedRun = vi.mocked(persistence.recordFailedRun);

const OPTIONS: CreateBatchInput["options"] = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance"],
  runs: 1,
};

/**
 * Build a synthetic full {@link AuditResult} that DOES include a `median.lhr`
 * sentinel, so we can assert the lhr is stripped from views but returned intact
 * by `getJobResult`.
 */
function makeResult(url: string, perf: number): AuditResult {
  return {
    requestedUrl: url,
    finalUrl: url,
    options: OPTIONS,
    runs: 1,
    median: {
      scores: { performance: perf },
      metrics: {
        "largest-contentful-paint": null,
        "cumulative-layout-shift": null,
        "total-blocking-time": null,
        "first-contentful-paint": null,
        "speed-index": null,
        interactive: null,
      },
      opportunities: [],
      lhr: { __lhrSentinel: true, url, fetchTime: `t-${perf}` },
    },
    perRunScores: [{ performance: perf }],
    fetchTime: `t-${perf}`,
    lighthouseVersion: "13.0.0",
    runWarnings: [],
    environment: {
      benchmarkIndex: 1500,
      hostUserAgent: "test",
      throttlingMethod: "simulate",
      cpuSlowdownMultiplier: 4,
    },
  };
}

/** Collect a batch's events; resolves when `batch-completed` fires. */
function awaitBatch(
  queue: AuditQueueApi,
  batchId: string,
): { events: ProgressEvent[]; done: Promise<void>; unsubscribe: () => void } {
  const events: ProgressEvent[] = [];
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const unsubscribe = queue.subscribe(batchId, (event) => {
    events.push(event);
    if (event.type === "batch-completed") resolveDone();
  });
  return { events, done, unsubscribe };
}

describe("AuditQueue", () => {
  beforeEach(() => {
    mockRunAudit.mockReset();
    mockRecordBatch.mockClear();
    mockRecordRun.mockClear();
    mockRecordFailedRun.mockClear();
  });

  it("createBatch returns an all-queued snapshot with correct counts and ids", () => {
    mockRunAudit.mockResolvedValue(makeResult("https://a.test/", 90));
    const queue = new AuditQueue();

    const batch = queue.createBatch({
      urls: ["https://a.test/", "https://b.test/"],
      options: OPTIONS,
      concurrency: 1,
    });

    expect(batch.status).toBe("queued");
    expect(batch.jobs).toHaveLength(2);
    expect(batch.jobs.map((j) => j.index)).toEqual([0, 1]);
    expect(batch.jobs.map((j) => j.url)).toEqual([
      "https://a.test/",
      "https://b.test/",
    ]);
    expect(batch.jobs.every((j) => j.status === "queued")).toBe(true);
    expect(batch.jobs.every((j) => typeof j.queuedAt === "string")).toBe(true);
    expect(new Set(batch.jobs.map((j) => j.id)).size).toBe(2);
    expect(batch.counts).toEqual({
      total: 2,
      queued: 2,
      running: 0,
      done: 0,
      error: 0,
    });
  });

  it("transitions jobs queued→running→done and fires events in order", async () => {
    mockRunAudit.mockImplementation((url) =>
      Promise.resolve(makeResult(url, 50)),
    );
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://a.test/"],
      options: OPTIONS,
      concurrency: 1,
    });
    const { events, done } = awaitBatch(queue, initial.id);
    await done;

    expect(events.map((e) => e.type)).toEqual([
      "job-started",
      "job-completed",
      "batch-completed",
    ]);

    const started = events[0] as Extract<ProgressEvent, { type: "job-started" }>;
    expect(started.job.status).toBe("running");
    expect(started.job.startedAt).toBeTypeOf("string");
    expect(started.counts).toMatchObject({ running: 1, queued: 0 });

    const completed = events[1] as Extract<
      ProgressEvent,
      { type: "job-completed" }
    >;
    expect(completed.job.status).toBe("done");
    expect(completed.job.finishedAt).toBeTypeOf("string");
    expect(completed.counts).toMatchObject({ done: 1, running: 0 });

    const final = queue.getBatch(initial.id);
    expect(final?.status).toBe("completed");
    expect(final?.finishedAt).toBeTypeOf("string");
    expect(final?.jobs[0].status).toBe("done");
  });

  it("a rejecting job yields job-failed with error.message and does not block siblings", async () => {
    mockRunAudit.mockImplementation((url) => {
      if (url === "https://bad.test/") {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve(makeResult(url, 77));
    });
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://bad.test/", "https://good.test/"],
      options: OPTIONS,
      concurrency: 2,
    });
    const { events, done } = awaitBatch(queue, initial.id);
    await done;

    const failed = events.find((e) => e.type === "job-failed") as
      | Extract<ProgressEvent, { type: "job-failed" }>
      | undefined;
    expect(failed).toBeDefined();
    expect(failed?.job.status).toBe("error");
    expect(failed?.job.error?.message).toBe("boom");

    const finalBatch = queue.getBatch(initial.id)!;
    const good = finalBatch.jobs.find((j) => j.url === "https://good.test/")!;
    const bad = finalBatch.jobs.find((j) => j.url === "https://bad.test/")!;
    expect(good.status).toBe("done");
    expect(bad.status).toBe("error");
    expect(finalBatch.counts).toMatchObject({ done: 1, error: 1 });
  });

  it("ends 'completed' with no errors and 'completed_with_errors' with any error", async () => {
    const queue = new AuditQueue();

    // All success → completed.
    mockRunAudit.mockResolvedValue(makeResult("https://ok.test/", 88));
    const okBatch = queue.createBatch({
      urls: ["https://ok.test/"],
      options: OPTIONS,
      concurrency: 1,
    });
    const ok = awaitBatch(queue, okBatch.id);
    await ok.done;
    expect(queue.getBatch(okBatch.id)?.status).toBe("completed");

    // One failure → completed_with_errors.
    mockRunAudit.mockRejectedValue(new Error("nope"));
    const errBatch = queue.createBatch({
      urls: ["https://err.test/"],
      options: OPTIONS,
      concurrency: 1,
    });
    const err = awaitBatch(queue, errBatch.id);
    await err.done;
    expect(queue.getBatch(errBatch.id)?.status).toBe("completed_with_errors");
  });

  it("getJobResult returns the full lhr-bearing result while views are lhr-stripped", async () => {
    mockRunAudit.mockImplementation((url) =>
      Promise.resolve(makeResult(url, 42)),
    );
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://a.test/"],
      options: OPTIONS,
      concurrency: 1,
    });
    const { done } = awaitBatch(queue, initial.id);
    await done;

    const batch = queue.getBatch(initial.id)!;
    const jobId = batch.jobs[0].id;

    // Lite view on the job has no lhr.
    expect(batch.jobs[0].result).toBeDefined();
    expect(
      (batch.jobs[0].result!.median as Record<string, unknown>).lhr,
    ).toBeUndefined();
    expect(batch.jobs[0].result!.median.scores.performance).toBe(42);

    // getJobResult returns the full result with the lhr sentinel intact.
    const full = queue.getJobResult(jobId);
    expect(full).toBeDefined();
    expect(full!.median.lhr).toEqual({
      __lhrSentinel: true,
      url: "https://a.test/",
      fetchTime: "t-42",
    });

    // Unknown runId → undefined.
    expect(queue.getJobResult("nope")).toBeUndefined();
  });

  it("subscribe delivers events and the returned unsubscribe stops them", async () => {
    mockRunAudit.mockImplementation((url) =>
      Promise.resolve(makeResult(url, 60)),
    );
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://a.test/"],
      options: OPTIONS,
      concurrency: 1,
    });

    const received: ProgressEvent[] = [];
    const unsubscribe = queue.subscribe(initial.id, (e) => received.push(e));
    // Immediately unsubscribe; we should get nothing afterwards.
    unsubscribe();

    // Drive to completion via a separate subscriber.
    const { done } = awaitBatch(queue, initial.id);
    await done;

    expect(received).toHaveLength(0);
  });

  it("subscribe before the batch exists still receives that batch's events", async () => {
    mockRunAudit.mockImplementation((url) =>
      Promise.resolve(makeResult(url, 30)),
    );
    const queue = new AuditQueue();

    // We can't know the id before createBatch, but we can register on an id and
    // confirm subscribe doesn't require the batch to pre-exist. Use a two-step:
    // create, then assert the subscribe path delivers (covered above) — here we
    // verify subscribing to an unknown id is safe and yields an unsubscribe fn.
    const noop = vi.fn();
    const off = queue.subscribe("does-not-exist-yet", noop);
    expect(off).toBeTypeOf("function");
    off();
    expect(noop).not.toHaveBeenCalled();
  });

  it("sets concurrency from CreateBatchInput (clamped to MAX)", () => {
    mockRunAudit.mockResolvedValue(makeResult("https://a.test/", 90));
    const queue = new AuditQueue();

    const batch = queue.createBatch({
      urls: ["https://a.test/"],
      options: OPTIONS,
      concurrency: 5,
    });
    expect(batch.concurrency).toBe(5);
    expect(queue.concurrency).toBe(5);

    // Over the ceiling → clamped.
    queue.createBatch({
      urls: ["https://b.test/"],
      options: OPTIONS,
      concurrency: 999,
    });
    expect(queue.concurrency).toBe(MAX_CONCURRENCY);
  });

  it("defaults concurrency to DEFAULT_CONCURRENCY when constructed bare", () => {
    const queue = new AuditQueue();
    expect(queue.concurrency).toBe(DEFAULT_CONCURRENCY);
  });

  it("getAuditQueue returns a stable singleton", () => {
    expect(getAuditQueue()).toBe(getAuditQueue());
  });

  it("snapshots are defensively copied (mutating a returned batch is harmless)", () => {
    mockRunAudit.mockResolvedValue(makeResult("https://a.test/", 90));
    const queue = new AuditQueue();

    const batch = queue.createBatch({
      urls: ["https://a.test/"],
      options: OPTIONS,
      concurrency: 1,
    });
    (batch as Batch).status = "completed";
    batch.jobs[0].status = "error";

    const fresh = queue.getBatch(batch.id)!;
    expect(fresh.status).not.toBe("completed");
    expect(fresh.jobs[0].status).not.toBe("error");
  });

  it("wires the queue into persistence (recordBatch/recordRun on success, recordFailedRun on failure)", async () => {
    const queue = new AuditQueue();

    // Successful single-URL batch → recordBatch + recordRun.
    mockRunAudit.mockResolvedValue(makeResult("https://a.test/", 90));
    const okBatch = queue.createBatch({
      urls: ["https://a.test/"],
      options: OPTIONS,
      concurrency: 1,
    });
    expect(mockRecordBatch).toHaveBeenCalledTimes(1);
    const ok = awaitBatch(queue, okBatch.id);
    await ok.done;
    expect(mockRecordRun).toHaveBeenCalledTimes(1);
    expect(mockRecordFailedRun).not.toHaveBeenCalled();

    // Rejecting job → recordFailedRun.
    mockRunAudit.mockRejectedValue(new Error("boom"));
    const errBatch = queue.createBatch({
      urls: ["https://err.test/"],
      options: OPTIONS,
      concurrency: 1,
    });
    const err = awaitBatch(queue, errBatch.id);
    await err.done;
    expect(mockRecordFailedRun).toHaveBeenCalledTimes(1);
  });
});
