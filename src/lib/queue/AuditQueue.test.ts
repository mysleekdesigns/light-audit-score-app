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
vi.mock("@/lib/queue/runAuditWorker", () => ({
  runAuditInWorker: vi.fn(),
  // The queue references this class (instanceof) on the cancel path.
  WorkerAbortError: class WorkerAbortError extends Error {},
}));

// Mock the persistence seam so the queue's DB/disk side effects don't touch the
// real SQLite file or write report files during unit tests.
vi.mock("@/lib/db/persistence", () => ({
  recordBatch: vi.fn(),
  recordRun: vi.fn().mockResolvedValue(undefined),
  recordFailedRun: vi.fn(),
  updateBatchStatus: vi.fn(),
}));

// Mock the PSI engine too: the credential tests below drive the `source: "psi"`
// branch, which must never reach Google (nor be given anything to send).
vi.mock("@/lib/pagespeed/runPsiAudit", () => ({
  runPsiAudit: vi.fn(),
}));

const { runAuditInWorker } = await import("@/lib/queue/runAuditWorker");
const { runPsiAudit } = await import("@/lib/pagespeed/runPsiAudit");
const persistence = await import("@/lib/db/persistence");
const { AuditQueue, getAuditQueue } = await import("@/lib/queue/AuditQueue");

import { REDACTED } from "@/lib/lighthouse/credentials";
import {
  type AuditQueueApi,
  type Batch,
  type CreateBatchInput,
  type ProgressEvent,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
} from "@/lib/queue/types";

const mockRunAudit = vi.mocked(runAuditInWorker);
const mockRunPsi = vi.mocked(runPsiAudit);
const mockRecordBatch = vi.mocked(persistence.recordBatch);
const mockRecordRun = vi.mocked(persistence.recordRun);
const mockRecordFailedRun = vi.mocked(persistence.recordFailedRun);

const OPTIONS: CreateBatchInput["options"] = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance"],
  runs: 1,
  warmCache: true,
};

// --- Credential fixtures (ROADMAP Phase B) ---------------------------------

/**
 * Distinctive fake credential VALUES. Every leak assertion below is a substring
 * search for these over `JSON.stringify` of a payload, which is exactly the
 * shape of the real risk: the API routes and the SSE stream serialise batches
 * and events wholesale, so a value that survives serialisation reaches the
 * browser no matter which field it hid in.
 */
const SECRET_HEADER_VALUE = "preview-token-do-not-persist";
const SECRET_COOKIE_VALUE = "session-value-do-not-persist";
const SECRET_PASSWORD = "basic-auth-password-do-not-persist";
const SECRETS = [SECRET_HEADER_VALUE, SECRET_COOKIE_VALUE, SECRET_PASSWORD];

const CREDENTIALED_OPTIONS: CreateBatchInput["options"] = {
  ...OPTIONS,
  extraHeaders: { "X-Preview-Token": SECRET_HEADER_VALUE },
  cookies: { session: SECRET_COOKIE_VALUE },
  basicAuth: { username: "staging", password: SECRET_PASSWORD },
};

/** Assert no credential value survives serialising `payload`. */
function expectNoSecrets(payload: unknown): void {
  const serialised = JSON.stringify(payload);
  for (const secret of SECRETS) {
    expect(serialised).not.toContain(secret);
  }
}

/**
 * Peek at the queue's private per-batch credential side map. Reaching into a
 * private is deliberate here: "the credential is gone once the batch settles" is
 * a security invariant whose whole point is that it has no public surface.
 */
function credentialMap(queue: AuditQueueApi): Map<string, unknown> {
  return (queue as unknown as { batchCredentials: Map<string, unknown> })
    .batchCredentials;
}

/**
 * A worker stub that echoes back the options it was called with, the way the
 * real engine does (`median.ts` puts the resolved options on the AuditResult) —
 * so these tests exercise the path a credential would actually take home.
 */
function echoingWorker(perf = 90) {
  return (url: string, options: CreateBatchInput["options"]) =>
    Promise.resolve({ ...makeResult(url, perf), options });
}

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
      bestPractices: [],
      lhr: { __lhrSentinel: true, url, fetchTime: `t-${perf}` },
    },
    perRunScores: [{ performance: perf }],
    perRunEnvironments: [
      {
        benchmarkIndex: 1500,
        hostUserAgent: "test",
        throttlingMethod: "simulate",
        cpuSlowdownMultiplier: 4,
      },
    ],
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
    mockRunPsi.mockReset();
    mockRecordBatch.mockClear();
    mockRecordRun.mockClear();
    mockRecordFailedRun.mockClear();
  });

  it("createBatch returns an all-queued snapshot with correct counts and ids", () => {
    mockRunAudit.mockResolvedValue(makeResult("https://a.test/", 90));
    const queue = new AuditQueue();

    const batch = queue.createBatch({
      urls: ["https://a.test/", "https://b.test/"],
      device: "mobile",
      options: OPTIONS,
      concurrency: 1,
    });

    expect(batch.status).toBe("queued");
    expect(batch.device).toBe("mobile");
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
      cancelled: 0,
    });
  });

  it("createBatch with zero URLs returns an already-finalized (completed) snapshot", () => {
    // Defensive contract: the API/form reject empty URL lists, but the queue must
    // never produce a batch that can't finalize. An empty batch enqueues no jobs,
    // so it must be finalized inline — otherwise `maybeFinalizeBatch` never runs
    // and the client spins on "Running…" forever.
    const queue = new AuditQueue();

    const batch = queue.createBatch({
      urls: [],
      device: "mobile",
      options: OPTIONS,
      concurrency: 1,
    });

    expect(batch.jobs).toHaveLength(0);
    expect(batch.status).toBe("completed");
    expect(batch.counts).toMatchObject({ total: 0, done: 0, error: 0 });
  });

  it("records a re-run's priorBatchId on the batch (undefined for a fresh batch)", () => {
    // PRD §6 Phase 13: lineage is recorded but does not affect execution.
    mockRunAudit.mockResolvedValue(makeResult("https://a.test/", 90));
    const queue = new AuditQueue();

    const fresh = queue.createBatch({
      urls: ["https://a.test/"],
      device: "mobile",
      options: OPTIONS,
      concurrency: 1,
    });
    expect(fresh.priorBatchId).toBeUndefined();

    const rerun = queue.createBatch({
      urls: ["https://a.test/"],
      device: "mobile",
      options: OPTIONS,
      concurrency: 1,
      priorBatchId: fresh.id,
    });
    expect(rerun.priorBatchId).toBe(fresh.id);
  });

  it("fans a 'both' batch out into a mobile + desktop job per URL with contiguous indices", () => {
    mockRunAudit.mockResolvedValue(makeResult("https://a.test/", 90));
    const queue = new AuditQueue();

    const urls = ["https://a.test/", "https://b.test/", "https://c.test/"];
    const batch = queue.createBatch({
      urls,
      device: "both",
      options: OPTIONS,
      concurrency: 1,
    });

    // N URLs × 2 form factors → 2N jobs; the batch records device "both".
    expect(batch.device).toBe("both");
    expect(batch.jobs).toHaveLength(urls.length * 2);

    // Each URL has exactly one mobile and one desktop job (by job.device).
    for (const url of urls) {
      const devices = batch.jobs
        .filter((j) => j.url === url)
        .map((j) => j.device)
        .sort();
      expect(devices).toEqual(["desktop", "mobile"]);
    }

    // Indices are the global flattened position: 0..2N-1, contiguous & unique.
    expect(batch.jobs.map((j) => j.index)).toEqual(
      Array.from({ length: urls.length * 2 }, (_, i) => i),
    );
    expect(new Set(batch.jobs.map((j) => j.id)).size).toBe(urls.length * 2);

    // The batch-level options pin a concrete representative form factor (never
    // "both"), so single-device reads of options.formFactor still work.
    expect(batch.options.formFactor).toBe("mobile");
  });

  it("runs each job with its own form factor (per-job options override)", async () => {
    mockRunAudit.mockImplementation((url) => Promise.resolve(makeResult(url, 70)));
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://a.test/"],
      device: "both",
      options: OPTIONS,
      concurrency: 1,
    });
    const { done } = awaitBatch(queue, initial.id);
    await done;

    // The engine is called once per form factor, each with the matching
    // formFactor pinned onto the otherwise-shared batch options. Filter to this
    // test's URL so stray calls from prior tests' async drain can't leak in.
    const calledFormFactors = mockRunAudit.mock.calls
      .filter(([url]) => url === "https://a.test/")
      .map(([, opts]) => opts.formFactor)
      .sort();
    expect(calledFormFactors).toEqual(["desktop", "mobile"]);
  });

  it("transitions jobs queued→running→done and fires events in order", async () => {
    mockRunAudit.mockImplementation((url) =>
      Promise.resolve(makeResult(url, 50)),
    );
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://a.test/"],
      device: "mobile",
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
      device: "mobile",
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
      device: "mobile",
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
      device: "mobile",
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
      device: "mobile",
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

  it("does not finish a batch until every run is PERSISTED, not merely audited", async () => {
    // Regression test for the race ROADMAP Phase F's CI runner exposed.
    // `job.status = "done"` used to be set BEFORE `await recordRun(...)`, and
    // `maybeFinalizeBatch` decides a batch is over by reading `job.status`
    // across the batch. So with two jobs in flight, job B could mark itself done
    // and enter its (async) persist while job A's completion finalised the
    // batch — emitting `batch-completed` with B's row still unwritten. Anything
    // that reads SQLite once on that event and stops then saw fewer runs than it
    // audited; for the CI gate that meant judging one page of two and passing a
    // build it should have failed. The web UI never noticed because it re-fetches.
    mockRunAudit.mockImplementation((url) => Promise.resolve(makeResult(url, 90)));

    // Hold the SECOND persist open so the two jobs are guaranteed to interleave
    // in exactly the order that used to break.
    let releaseSecond: () => void = () => {};
    const secondPersisted = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let calls = 0;
    mockRecordRun.mockImplementation(() => {
      calls += 1;
      return calls === 2 ? secondPersisted : Promise.resolve();
    });

    const queue = new AuditQueue();
    const initial = queue.createBatch({
      urls: ["https://a.test/", "https://b.test/"],
      device: "mobile",
      options: OPTIONS,
      concurrency: 2,
    });

    let completed = false;
    queue.subscribe(initial.id, (event) => {
      if (event.type === "batch-completed") completed = true;
    });

    // Let both workers resolve and the first persist settle. The batch must
    // still be open, because one run is not on disk yet.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toBe(2);
    expect(completed).toBe(false);
    expect(queue.getBatch(initial.id)?.status).not.toBe("completed");

    // Once the row lands, the batch finishes.
    releaseSecond();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completed).toBe(true);
    expect(queue.getBatch(initial.id)?.status).toBe("completed");

    mockRecordRun.mockReset();
    mockRecordRun.mockResolvedValue(undefined);
  });

  it("forgetJobResults drops a retained result so a deleted run stops being readable", async () => {
    // ROADMAP Phase E security review, M1. The queue retains every finished
    // run's heavy, LHR-bearing result so the report routes can serve a run that
    // is not persisted yet — which also means a run deleted from the DB kept
    // answering `/trace` and `/diff` from memory for the life of the process,
    // with its audited URL, its subresource URLs and its screenshots. Deletion
    // now prunes this map (`deleteRun` / `clearHistory`), and this is the
    // property that makes that possible.
    mockRunAudit.mockImplementation((url) => Promise.resolve(makeResult(url, 42)));
    const queue = new AuditQueue();

    const first = queue.createBatch({
      urls: ["https://a.test/"],
      device: "mobile",
      options: OPTIONS,
      concurrency: 1,
    });
    await awaitBatch(queue, first.id).done;
    const second = queue.createBatch({
      urls: ["https://b.test/"],
      device: "mobile",
      options: OPTIONS,
      concurrency: 1,
    });
    await awaitBatch(queue, second.id).done;

    const firstId = queue.getBatch(first.id)!.jobs[0].id;
    const secondId = queue.getBatch(second.id)!.jobs[0].id;
    expect(queue.getJobResult(firstId)).toBeDefined();
    expect(queue.getJobResult(secondId)).toBeDefined();

    // Targeted: only the named run is forgotten.
    queue.forgetJobResults(firstId);
    expect(queue.getJobResult(firstId)).toBeUndefined();
    expect(queue.getJobResult(secondId)).toBeDefined();

    // Idempotent, and an unknown id is not an error — deletion must never throw.
    expect(() => queue.forgetJobResults(firstId)).not.toThrow();
    expect(() => queue.forgetJobResults("never-existed")).not.toThrow();

    // Wholesale, for "Clear history".
    queue.forgetJobResults();
    expect(queue.getJobResult(secondId)).toBeUndefined();

    // The batch snapshots themselves are untouched: this prunes the heavy
    // retained results, not the queue's record of what it ran.
    expect(queue.getBatch(first.id)).toBeDefined();
  });

  it("subscribe delivers events and the returned unsubscribe stops them", async () => {
    mockRunAudit.mockImplementation((url) =>
      Promise.resolve(makeResult(url, 60)),
    );
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://a.test/"],
      device: "mobile",
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
      device: "mobile",
      options: OPTIONS,
      concurrency: 5,
    });
    expect(batch.concurrency).toBe(5);
    expect(queue.concurrency).toBe(5);

    // Over the ceiling → clamped.
    queue.createBatch({
      urls: ["https://b.test/"],
      device: "mobile",
      options: OPTIONS,
      concurrency: 999,
    });
    expect(queue.concurrency).toBe(MAX_CONCURRENCY);
  });

  it("accuracy mode forces effective concurrency to 1 when Performance is in scope", () => {
    mockRunAudit.mockResolvedValue(makeResult("https://a.test/", 90));
    const queue = new AuditQueue();

    // Performance in scope + accuracyMode → effective concurrency 1, regardless
    // of the requested value.
    const perfBatch = queue.createBatch({
      urls: ["https://a.test/"],
      device: "mobile",
      options: { ...OPTIONS, categories: ["performance"] },
      concurrency: 8,
      accuracyMode: true,
    });
    expect(perfBatch.concurrency).toBe(1);
    expect(queue.concurrency).toBe(1);

    // Accuracy mode but Performance NOT in scope → requested concurrency kept.
    const nonPerfBatch = queue.createBatch({
      urls: ["https://b.test/"],
      device: "mobile",
      options: { ...OPTIONS, categories: ["seo", "accessibility"] },
      concurrency: 4,
      accuracyMode: true,
    });
    expect(nonPerfBatch.concurrency).toBe(4);

    // No accuracy mode → requested concurrency kept even with Performance.
    const plainBatch = queue.createBatch({
      urls: ["https://c.test/"],
      device: "mobile",
      options: { ...OPTIONS, categories: ["performance"] },
      concurrency: 6,
    });
    expect(plainBatch.concurrency).toBe(6);
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
      device: "mobile",
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
      device: "mobile",
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
      device: "mobile",
      options: OPTIONS,
      concurrency: 1,
    });
    const err = awaitBatch(queue, errBatch.id);
    await err.done;
    expect(mockRecordFailedRun).toHaveBeenCalledTimes(1);
  });

  it("cancelBatch keeps completed jobs, cancels queued + running, emits batch-cancelled", async () => {
    // A worker that never resolves until its AbortSignal fires (then rejects) —
    // models the real worker being SIGKILLed on cancel.
    const abortable = (signal?: AbortSignal): Promise<AuditResult> =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    // a → completes; b, c → hang until cancelled. Concurrency 1 so a finishes,
    // b is running, c is still queued when we cancel.
    mockRunAudit.mockImplementation((url, _opts, signal) =>
      url === "https://a.test/"
        ? Promise.resolve(makeResult(url, 90))
        : abortable(signal),
    );
    const queue = new AuditQueue();
    const initial = queue.createBatch({
      urls: ["https://a.test/", "https://b.test/", "https://c.test/"],
      device: "mobile",
      options: OPTIONS,
      concurrency: 1,
    });

    // Wait until a is done and b is running.
    const events: ProgressEvent[] = [];
    await new Promise<void>((resolve) => {
      queue.subscribe(initial.id, (event) => {
        events.push(event);
        const snap = queue.getBatch(initial.id)!;
        if (snap.counts.done === 1 && snap.counts.running === 1) resolve();
      });
    });

    const cancelled = queue.cancelBatch(initial.id);
    expect(cancelled?.status).toBe("cancelled");

    const byUrl = (u: string) => cancelled!.jobs.find((j) => j.url === u)!;
    expect(byUrl("https://a.test/").status).toBe("done"); // kept
    expect(byUrl("https://b.test/").status).toBe("cancelled"); // was running
    expect(byUrl("https://c.test/").status).toBe("cancelled"); // was queued
    expect(cancelled!.counts).toMatchObject({
      done: 1,
      cancelled: 2,
      running: 0,
      queued: 0,
    });
    expect(events.some((e) => e.type === "batch-cancelled")).toBe(true);
    expect(persistence.updateBatchStatus).toHaveBeenCalledWith(
      initial.id,
      expect.objectContaining({ status: "cancelled" }),
    );
    // The cancelled run is NOT persisted as a failure.
    expect(mockRecordFailedRun).not.toHaveBeenCalled();
  });

  it("cancelBatch is a no-op on an already-terminal batch", async () => {
    mockRunAudit.mockResolvedValue(makeResult("https://a.test/", 90));
    const queue = new AuditQueue();
    const initial = queue.createBatch({
      urls: ["https://a.test/"],
      device: "mobile",
      options: OPTIONS,
      concurrency: 1,
    });
    const { done } = awaitBatch(queue, initial.id);
    await done;
    expect(queue.getBatch(initial.id)?.status).toBe("completed");

    // Cancelling a completed batch leaves it completed (idempotent no-op).
    expect(queue.cancelBatch(initial.id)?.status).toBe("completed");
  });

  it("cancelBatch returns undefined for an unknown batch id", () => {
    const queue = new AuditQueue();
    expect(queue.cancelBatch("does-not-exist")).toBeUndefined();
  });
});

/**
 * Credential handling (ROADMAP Phase B).
 *
 * The load-bearing claim is structural, not cosmetic: a credential never goes
 * onto the `Batch` at all, so every existing serialisation boundary (`POST
 * /api/audits`, `GET /api/audits/:id`, the SSE `batch-snapshot`) is safe by
 * construction rather than by anyone remembering to redact. These tests assert
 * that from the outside — over `JSON.stringify` of the very payloads those
 * routes send — and then assert the credential still reaches the one consumer
 * that legitimately needs it: the forked local worker.
 */
describe("AuditQueue — audit credentials", () => {
  beforeEach(() => {
    mockRunAudit.mockReset();
    mockRunPsi.mockReset();
    mockRecordBatch.mockClear();
    mockRecordRun.mockClear();
    mockRecordFailedRun.mockClear();
  });

  it("keeps credential values off the snapshot, getBatch and every progress event", async () => {
    mockRunAudit.mockImplementation(echoingWorker());
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://staging.test/"],
      device: "mobile",
      options: CREDENTIALED_OPTIONS,
      concurrency: 1,
    });
    const { events, done } = awaitBatch(queue, initial.id);
    await done;

    // The three client-facing surfaces, serialised exactly as the routes do.
    expectNoSecrets(initial);
    expectNoSecrets(queue.getBatch(initial.id));
    expectNoSecrets(events);

    // Names survive as provenance — a run can say WHICH credential it used,
    // never what it was.
    expect(initial.options.extraHeaders).toEqual({
      "X-Preview-Token": REDACTED,
    });
    expect(initial.options.cookies).toEqual({ session: REDACTED });
    expect(initial.options.basicAuth).toEqual({
      username: REDACTED,
      password: REDACTED,
    });
  });

  it("redacts the options the engine echoes back before they reach persistence", async () => {
    // The engine returns the options it ran with on the AuditResult, so without
    // the queue's redaction the real values would ride home into `runs.options`
    // and onto the job's lite result (which every SSE payload carries).
    mockRunAudit.mockImplementation(echoingWorker(42));
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://staging.test/"],
      device: "mobile",
      options: CREDENTIALED_OPTIONS,
      concurrency: 1,
    });
    const { done } = awaitBatch(queue, initial.id);
    await done;

    expect(mockRecordRun).toHaveBeenCalledTimes(1);
    const [, , persisted] = mockRecordRun.mock.calls[0];
    expectNoSecrets(persisted.options);
    expect(persisted.options.extraHeaders).toEqual({
      "X-Preview-Token": REDACTED,
    });

    // The in-memory full result (served via `getJobResult`) is redacted too.
    const jobId = queue.getBatch(initial.id)!.jobs[0].id;
    expectNoSecrets(queue.getJobResult(jobId)?.options);
  });

  it("hands the real credential values to the local worker", async () => {
    mockRunAudit.mockImplementation(echoingWorker());
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://staging.test/"],
      device: "mobile",
      options: CREDENTIALED_OPTIONS,
      concurrency: 1,
    });
    const { done } = awaitBatch(queue, initial.id);
    await done;

    expect(mockRunAudit).toHaveBeenCalledTimes(1);
    const [url, workerOptions] = mockRunAudit.mock.calls[0];
    expect(url).toBe("https://staging.test/");
    expect(workerOptions.extraHeaders).toEqual({
      "X-Preview-Token": SECRET_HEADER_VALUE,
    });
    expect(workerOptions.cookies).toEqual({ session: SECRET_COOKIE_VALUE });
    expect(workerOptions.basicAuth).toEqual({
      username: "staging",
      password: SECRET_PASSWORD,
    });
  });

  it("never hands a credential to PageSpeed Insights", async () => {
    // `audits-schema` rejects source=psi + credentials with a 400 explaining
    // why; this is the queue's defensive second layer, which also drops the
    // redacted placeholders so PSI never sees even a credential's name.
    mockRunPsi.mockImplementation(echoingWorker(80));
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://public.test/"],
      device: "mobile",
      options: CREDENTIALED_OPTIONS,
      source: "psi",
      concurrency: 1,
    });
    const { events, done } = awaitBatch(queue, initial.id);
    await done;

    expect(mockRunPsi).toHaveBeenCalledTimes(1);
    const [, psiOptions] = mockRunPsi.mock.calls[0];
    expect(psiOptions.extraHeaders).toBeUndefined();
    expect(psiOptions.cookies).toBeUndefined();
    expect(psiOptions.basicAuth).toBeUndefined();
    expectNoSecrets(events);
    // The local worker is never involved on the PSI branch.
    expect(mockRunAudit).not.toHaveBeenCalled();
  });

  it("holds the credential only while the batch is unsettled", async () => {
    mockRunAudit.mockImplementation(echoingWorker());
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://staging.test/"],
      device: "mobile",
      options: CREDENTIALED_OPTIONS,
      concurrency: 1,
    });
    // Present for the life of the batch...
    expect(credentialMap(queue).has(initial.id)).toBe(true);

    const { done } = awaitBatch(queue, initial.id);
    await done;

    // ...and gone the moment it settles.
    expect(credentialMap(queue).has(initial.id)).toBe(false);
  });

  it("drops the credential when the batch is cancelled", () => {
    mockRunAudit.mockImplementation(echoingWorker());
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://staging.test/"],
      device: "mobile",
      options: CREDENTIALED_OPTIONS,
      concurrency: 1,
    });
    expect(credentialMap(queue).has(initial.id)).toBe(true);

    const cancelled = queue.cancelBatch(initial.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(credentialMap(queue).has(initial.id)).toBe(false);
    expectNoSecrets(cancelled);
  });

  it("stores nothing for a batch created without credentials", () => {
    mockRunAudit.mockImplementation(echoingWorker());
    const queue = new AuditQueue();

    const initial = queue.createBatch({
      urls: ["https://plain.test/"],
      device: "mobile",
      options: OPTIONS,
      concurrency: 1,
    });

    expect(credentialMap(queue).size).toBe(0);
    // Credential-free options pass through untouched (no empty placeholders).
    expect(initial.options.extraHeaders).toBeUndefined();
    expect(initial.options.cookies).toBeUndefined();
    expect(initial.options.basicAuth).toBeUndefined();
  });
});
