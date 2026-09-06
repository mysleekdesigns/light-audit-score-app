/**
 * Scheduler unit tests (PRD §6 Phase 14).
 *
 * Each test isolates state by:
 *  - Pointing `LH_DATA_DIR`/`LH_DB_PATH` at a per-case temp dir (so schedules +
 *    batches land in a throwaway SQLite that drizzle migrates fresh).
 *  - Building a fresh scheduler via `createSchedulerForTests()` and driving
 *    `tick(now)` directly with a fast-forwarded `Date` — we never call `start()`
 *    or wait on real timers.
 *  - Mocking `runAuditInWorker` so the queue does not fork Chrome. The queue
 *    itself stays real, which lets us assert that fired batches carry
 *    `scheduleId`. Discovery is mocked too so a crawl target never hits the
 *    network.
 *  - Mocking `deliverAlerts` (ROADMAP Phase C) so the alert tests assert what
 *    *would* be sent without an HTTP call. Everything below delivery — the
 *    comparison, the SQLite rows, the idempotence marker — stays real.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the process-isolated audit runner so the queue never launches Chrome.
vi.mock("@/lib/queue/runAuditWorker", () => ({
  runAuditInWorker: vi.fn(),
  // The queue's settle path does `instanceof WorkerAbortError`; a missing
  // export would throw inside its catch block once a job is cancelled.
  WorkerAbortError: class WorkerAbortError extends Error {},
}));
// Mock discovery so a crawl target's resolveUrls() doesn't hit the network.
vi.mock("@/lib/crawl/discover", () => ({ discover: vi.fn() }));
// Mock webhook delivery: the alert tests care about what would be sent, not
// about reaching a Slack endpoint. Nothing else in the alert path is stubbed.
vi.mock("@/lib/alerts/deliver", () => ({ deliverAlerts: vi.fn() }));

const { runAuditInWorker } = await import("@/lib/queue/runAuditWorker");
const { discover } = await import("@/lib/crawl/discover");
const { deliverAlerts } = await import("@/lib/alerts/deliver");
const { resetDbForTests } = await import("@/lib/db/client");
const {
  createSchedule,
  getAlertsEvaluatedBatchId,
  getSchedule,
  listSchedules,
  recordScheduleFire,
} = await import("@/lib/db/schedules");
const { listScheduleAlerts } = await import("@/lib/db/alerts");
const { createSchedulerForTests, evaluateBatchAlerts, fireSchedule } =
  await import("@/lib/schedules/scheduler");
const { getAuditQueue } = await import("@/lib/queue/AuditQueue");

/** Wait until the audit queue is idle (all enqueued jobs done). */
async function drainQueue(): Promise<void> {
  // The queue exposes only `subscribe`; we don't have a per-batch id here, so
  // just yield to the microtask queue until the mock has settled. PQueue runs
  // tasks via the microtask loop, and our mock resolves synchronously, so a
  // handful of awaits is enough to fully drain.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

import {
  DEFAULT_SCHEDULE_NOTIFY,
  type ScheduleNotify,
} from "@/lib/alerts/types";
import type { AuditOptions, AuditResult } from "@/lib/lighthouse/types";
import { DEFAULT_OPTIONS } from "@/lib/lighthouse/options";
import type { CreateScheduleInput } from "@/lib/schedules/types";

/**
 * Poll `predicate` until it holds, yielding to timers between checks so the
 * queue's tasks (and their awaited report writes) can make progress. Fails the
 * test rather than hanging when the condition never arrives.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/**
 * Point the worker mock at a fake engine where jobs matching `blocks` hang
 * until their batch is cancelled (resolving on abort, exactly as a killed
 * worker settles), and every other job finishes immediately.
 */
function blockJobs(
  blocks: (url: string, options: AuditOptions) => boolean,
): void {
  mockRunAudit.mockImplementation((url, options, signal) => {
    if (!blocks(url, options)) return Promise.resolve(makeResult(url));
    return new Promise<AuditResult>((resolve) => {
      signal?.addEventListener("abort", () => resolve(makeResult(url)), {
        once: true,
      });
    });
  });
}

/** URLs the worker mock was asked to audit, in call order. */
function auditedUrls(): string[] {
  return mockRunAudit.mock.calls.map((call) => call[0]);
}

const mockRunAudit = vi.mocked(runAuditInWorker);
const mockDiscover = vi.mocked(discover);
const mockDeliverAlerts = vi.mocked(deliverAlerts);

/**
 * Performance score the worker mock reports for the next fire. The alert tests
 * move this between fires — the whole feature is "what changed since last
 * time", so a schedule has to be able to produce two different numbers.
 */
let nextScore = 90;

function makeResult(url: string, performance: number = nextScore): AuditResult {
  return {
    requestedUrl: url,
    finalUrl: url,
    options: DEFAULT_OPTIONS,
    runs: 1,
    median: {
      scores: { performance },
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
      lhr: { fake: true },
    },
    perRunScores: [{ performance }],
    perRunEnvironments: [
      {
        benchmarkIndex: 1500,
        hostUserAgent: "test",
        throttlingMethod: "simulate",
        cpuSlowdownMultiplier: 4,
      },
    ],
    fetchTime: new Date().toISOString(),
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

function makeInput(overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    name: "test",
    enabled: true,
    cadence: "daily",
    time: "09:00",
    target: { kind: "urls", urls: ["https://example.com/"] },
    options: DEFAULT_OPTIONS,
    concurrency: 1,
    device: "mobile",
    accuracyMode: false,
    source: "local",
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-sched-"));
  process.env.LH_DATA_DIR = tmpDir;
  process.env.LH_DB_PATH = path.join(tmpDir, "test.db");
  resetDbForTests();
  nextScore = 90;
  mockRunAudit.mockReset();
  mockRunAudit.mockImplementation((url) => Promise.resolve(makeResult(url)));
  mockDiscover.mockReset();
  mockDeliverAlerts.mockReset();
  mockDeliverAlerts.mockResolvedValue({ attempted: true, delivered: true });
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.LH_DATA_DIR;
  delete process.env.LH_DB_PATH;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("scheduler.tick", () => {
  it("fires a due schedule, sets lastFiredAt + lastBatchId, and tags the batch with scheduleId", async () => {
    const schedule = createSchedule(makeInput({ time: "09:00" }))!;
    expect(schedule).not.toBeNull();
    expect(schedule.lastFiredAt).toBeNull();

    const scheduler = createSchedulerForTests();
    // 09:00 sharp — at-or-past the cutoff, never-fired → due.
    const now = new Date(2026, 4, 28, 9, 0, 0, 0);
    await scheduler.tick(now);
    await drainQueue();

    // The audit worker was invoked once per URL on the resolved target.
    expect(mockRunAudit).toHaveBeenCalledTimes(1);
    expect(mockRunAudit.mock.calls[0][0]).toBe("https://example.com/");

    // The persistence layer recorded the fire on the schedule row.
    const after = getSchedule(schedule.id)!;
    expect(after.lastFiredAt).not.toBeNull();
    expect(after.lastBatchId).not.toBeNull();
  });

  it("a second tick within the same cadence cycle is a no-op", async () => {
    createSchedule(makeInput({ time: "09:00" }))!;
    const scheduler = createSchedulerForTests();

    const fire = new Date(2026, 4, 28, 9, 0, 0, 0);
    await scheduler.tick(fire);
    await drainQueue();
    expect(mockRunAudit).toHaveBeenCalledTimes(1);

    // Tick again one minute later — lastFiredAt is now after the cutoff, so
    // the schedule should not re-fire.
    mockRunAudit.mockClear();
    const later = new Date(2026, 4, 28, 9, 1, 0, 0);
    await scheduler.tick(later);
    await drainQueue();
    expect(mockRunAudit).not.toHaveBeenCalled();
  });

  it("does NOT fire a disabled schedule", async () => {
    createSchedule(makeInput({ enabled: false, time: "09:00" }))!;
    const scheduler = createSchedulerForTests();

    const now = new Date(2026, 4, 28, 9, 0, 0, 0);
    await scheduler.tick(now);

    expect(mockRunAudit).not.toHaveBeenCalled();
  });

  it("skips a crawl-target schedule whose discovery resolves to zero URLs without crashing", async () => {
    mockDiscover.mockResolvedValue({
      origin: "https://example.com",
      urls: [],
      warnings: ["empty"],
      totalFound: 0,
      robotsBlocked: false,
    });
    const schedule = createSchedule(
      makeInput({
        target: {
          kind: "crawl",
          spec: {
            url: "https://example.com",
            useSitemap: true,
            useCrawl: false,
            maxDepth: 1,
            maxPages: 25,
            excludePaths: [],
          },
        },
      }),
    )!;
    const scheduler = createSchedulerForTests();

    const now = new Date(2026, 4, 28, 9, 0, 0, 0);
    await expect(scheduler.tick(now)).resolves.toBeUndefined();

    // No audit ran (no URLs to audit) and the schedule was NOT marked as fired
    // (recordScheduleFire is only called after a successful batch).
    expect(mockRunAudit).not.toHaveBeenCalled();
    expect(getSchedule(schedule.id)!.lastFiredAt).toBeNull();
  });

  it("fires the next due schedule even when a sibling fails", async () => {
    // A crawl schedule that resolves to 0 URLs (skipped) + a urls schedule
    // (should still fire). Order doesn't matter — listSchedules is newest-first
    // by createdAt, but the scheduler iterates them all regardless.
    mockDiscover.mockResolvedValue({
      origin: "https://example.com",
      urls: [],
      warnings: [],
      totalFound: 0,
      robotsBlocked: false,
    });
    createSchedule(
      makeInput({
        name: "empty-crawl",
        target: {
          kind: "crawl",
          spec: {
            url: "https://example.com",
            useSitemap: true,
            useCrawl: false,
            maxDepth: 1,
            maxPages: 5,
            excludePaths: [],
          },
        },
      }),
    );
    const okSchedule = createSchedule(
      makeInput({
        name: "ok-urls",
        target: { kind: "urls", urls: ["https://ok.test/"] },
      }),
    )!;

    const scheduler = createSchedulerForTests();
    const now = new Date(2026, 4, 28, 9, 0, 0, 0);
    await scheduler.tick(now);
    await drainQueue();

    // Exactly one URL audited (the ok schedule's), the other schedule was skipped.
    expect(mockRunAudit).toHaveBeenCalledTimes(1);
    expect(mockRunAudit.mock.calls[0][0]).toBe("https://ok.test/");
    expect(getSchedule(okSchedule.id)!.lastBatchId).not.toBeNull();
  });
});

describe("scheduler.runNow", () => {
  it("force-fires a schedule by id and returns the new batchId", async () => {
    const schedule = createSchedule(makeInput({ time: "23:59" }))!;
    const scheduler = createSchedulerForTests();

    const outcome = await scheduler.runNow(schedule.id);
    await drainQueue();
    expect(outcome).not.toBeNull();
    expect(typeof outcome!.batchId).toBe("string");
    // Nothing to resume: a plain full fire.
    expect(outcome).toMatchObject({ urlCount: 1, resumedFrom: null, skipped: 0 });
    expect(mockRunAudit).toHaveBeenCalledTimes(1);
    // The schedule's row reflects the forced fire.
    expect(getSchedule(schedule.id)!.lastBatchId).toBe(outcome!.batchId);
  });

  it("returns null for an unknown schedule id without firing anything", async () => {
    const scheduler = createSchedulerForTests();
    const outcome = await scheduler.runNow("does-not-exist");
    expect(outcome).toBeNull();
    expect(mockRunAudit).not.toHaveBeenCalled();
  });
});

describe("pause + resume", () => {
  const URLS = ["https://a.test/", "https://b.test/", "https://c.test/"];

  /**
   * Fire a three-URL schedule at concurrency 1 with `b` blocked, and wait until
   * `a` is done and `b` is the job in flight — the state a user sees when they
   * hit Pause part-way through a run.
   */
  async function fireAndBlockOnB(scheduler: ReturnType<typeof createSchedulerForTests>) {
    const schedule = createSchedule(
      makeInput({ target: { kind: "urls", urls: URLS }, concurrency: 1 }),
    )!;
    blockJobs((url) => url === "https://b.test/");
    const first = (await scheduler.runNow(schedule.id))!;
    const queue = getAuditQueue();
    await waitFor(() => {
      const counts = queue.getBatch(first.batchId)?.counts;
      return counts?.done === 1 && counts.running === 1;
    }, "a done, b running");
    return { schedule, first, queue };
  }

  it("cancelActiveBatches stops the schedule's running batch and keeps the finished run", async () => {
    const scheduler = createSchedulerForTests();
    const { schedule, first, queue } = await fireAndBlockOnB(scheduler);
    expect(first).toMatchObject({ urlCount: 3, resumedFrom: null, skipped: 0 });

    const cancelled = scheduler.cancelActiveBatches(schedule.id);
    expect(cancelled.map((b) => b.id)).toEqual([first.batchId]);

    const snapshot = queue.getBatch(first.batchId)!;
    expect(snapshot.status).toBe("cancelled");
    // `a` keeps its result; `b` (running) and `c` (still queued) are cancelled.
    expect(snapshot.jobs.map((j) => j.status)).toEqual([
      "done",
      "cancelled",
      "cancelled",
    ]);
    // Nothing left in flight: a second pause is a no-op.
    expect(scheduler.cancelActiveBatches(schedule.id)).toEqual([]);
  });

  it("cancelActiveBatches is a no-op for a schedule with nothing running", async () => {
    const schedule = createSchedule(makeInput())!;
    const scheduler = createSchedulerForTests();
    expect(scheduler.cancelActiveBatches(schedule.id)).toEqual([]);
    // A completed run is not touched either.
    const outcome = (await scheduler.runNow(schedule.id))!;
    await waitFor(
      () => getAuditQueue().getBatch(outcome.batchId)?.status === "completed",
      "full fire completed",
    );
    expect(scheduler.cancelActiveBatches(schedule.id)).toEqual([]);
    expect(scheduler.cancelActiveBatches("does-not-exist")).toEqual([]);
  });

  it("runNow after a pause skips URLs that already have a result, and chains across a second pause", async () => {
    const scheduler = createSchedulerForTests();
    const { schedule, first, queue } = await fireAndBlockOnB(scheduler);
    scheduler.cancelActiveBatches(schedule.id);

    // Resume: `a` is skipped; `b` (was running) and `c` (was queued) run, and
    // the new batch links back to the paused one. Block on `c` this time.
    blockJobs((url) => url === "https://c.test/");
    mockRunAudit.mockClear();
    const second = (await scheduler.runNow(schedule.id))!;
    expect(second).toMatchObject({
      urlCount: 2,
      resumedFrom: first.batchId,
      skipped: 1,
    });
    expect(queue.getBatch(second.batchId)!.priorBatchId).toBe(first.batchId);
    await waitFor(() => {
      const counts = queue.getBatch(second.batchId)?.counts;
      return counts?.done === 1 && counts.running === 1;
    }, "b done, c running");
    expect(auditedUrls()).toEqual(["https://b.test/", "https://c.test/"]);

    // Pause again part-way: the next resume must credit BOTH paused legs, so
    // only `c` is left.
    scheduler.cancelActiveBatches(schedule.id);
    blockJobs(() => false);
    mockRunAudit.mockClear();
    const third = (await scheduler.runNow(schedule.id))!;
    expect(third).toMatchObject({
      urlCount: 1,
      resumedFrom: second.batchId,
      skipped: 2,
    });
    await waitFor(
      () => queue.getBatch(third.batchId)?.status === "completed",
      "third batch completed",
    );
    expect(auditedUrls()).toEqual(["https://c.test/"]);
    expect(getSchedule(schedule.id)!.lastBatchId).toBe(third.batchId);

    // The run is complete, so the next Run now is an ordinary full fire.
    mockRunAudit.mockClear();
    const fourth = (await scheduler.runNow(schedule.id))!;
    await waitFor(
      () => queue.getBatch(fourth.batchId)?.status === "completed",
      "fourth batch completed",
    );
    expect(fourth).toMatchObject({ urlCount: 3, resumedFrom: null, skipped: 0 });
    expect(auditedUrls()).toEqual(URLS);
  });

  it("resume re-runs a 'both' URL in full unless every form factor already has a result", async () => {
    const schedule = createSchedule(
      makeInput({
        target: { kind: "urls", urls: ["https://a.test/"] },
        device: "both",
        concurrency: 1,
      }),
    )!;
    // Mobile leg finishes; the desktop leg hangs until paused.
    blockJobs((_url, options) => options.formFactor === "desktop");
    const scheduler = createSchedulerForTests();
    const first = (await scheduler.runNow(schedule.id))!;
    const queue = getAuditQueue();
    await waitFor(() => {
      const counts = queue.getBatch(first.batchId)?.counts;
      return counts?.done === 1 && counts.running === 1;
    }, "mobile done, desktop running");
    scheduler.cancelActiveBatches(schedule.id);

    blockJobs(() => false);
    mockRunAudit.mockClear();
    const second = (await scheduler.runNow(schedule.id))!;
    // Half-finished URL: not skipped, both legs run again, lineage kept.
    expect(second).toMatchObject({
      urlCount: 1,
      resumedFrom: first.batchId,
      skipped: 0,
    });
    await waitFor(
      () => queue.getBatch(second.batchId)?.status === "completed",
      "resumed both-batch completed",
    );
    expect(mockRunAudit.mock.calls.map((c) => c[1].formFactor)).toEqual([
      "mobile",
      "desktop",
    ]);
  });

  it("resume still skips finished URLs after a restart, from the persisted runs", async () => {
    const scheduler = createSchedulerForTests();
    const { schedule, first } = await fireAndBlockOnB(scheduler);
    scheduler.cancelActiveBatches(schedule.id);

    // Simulate a server restart: the live queue forgets the batch, so the
    // scheduler has to fall back to the persisted batch + its `done` run rows.
    (globalThis as { __auditQueue?: unknown }).__auditQueue = undefined;
    expect(getAuditQueue().getBatch(first.batchId)).toBeUndefined();

    blockJobs(() => false);
    mockRunAudit.mockClear();
    const second = (await scheduler.runNow(schedule.id))!;
    expect(second).toMatchObject({
      urlCount: 2,
      resumedFrom: first.batchId,
      skipped: 1,
    });
    await waitFor(
      () => getAuditQueue().getBatch(second.batchId)?.status === "completed",
      "resumed batch completed after restart",
    );
    expect(auditedUrls()).toEqual(["https://b.test/", "https://c.test/"]);
  });

  it("the cadence tick never resumes — a daily fire is always the full target", async () => {
    const scheduler = createSchedulerForTests();
    const { schedule } = await fireAndBlockOnB(scheduler);
    scheduler.cancelActiveBatches(schedule.id);

    // Move lastFiredAt behind the 09:00 cutoff so the next tick is due.
    // (runNow recorded a fire "now"; the test clock is a day later.)
    blockJobs(() => false);
    mockRunAudit.mockClear();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setHours(9, 0, 0, 0);
    await scheduler.tick(tomorrow);
    await waitFor(
      () =>
        getAuditQueue().getBatch(getSchedule(schedule.id)!.lastBatchId!)
          ?.status === "completed",
      "daily fire completed",
    );
    expect(auditedUrls()).toEqual(URLS);
  });
});

describe("fireSchedule (direct)", () => {
  it("returns null when a urls target is empty (defensive) without throwing", async () => {
    // Persisted rows always have ≥1 URL (parseCreateScheduleBody enforces it),
    // but the runtime guard is still in fireSchedule — exercise it directly.
    const schedule = createSchedule(makeInput())!;
    const empty = { ...schedule, target: { kind: "urls" as const, urls: [] } };
    const result = await fireSchedule(empty);
    expect(result).toBeNull();
    expect(mockRunAudit).not.toHaveBeenCalled();
  });

  it("does not throw and returns null when the queue is unavailable on a bad target shape", async () => {
    // Sanity: listSchedules drops unparseable rows, but if a programmer hands us
    // a Schedule with a discover-failing crawl spec we still swallow.
    mockDiscover.mockRejectedValue(new Error("network down"));
    const schedule = createSchedule(
      makeInput({
        target: {
          kind: "crawl",
          spec: {
            url: "https://example.com",
            useSitemap: true,
            useCrawl: false,
            maxDepth: 1,
            maxPages: 5,
            excludePaths: [],
          },
        },
      }),
    )!;
    const result = await fireSchedule(schedule);
    expect(result).toBeNull();
    // listSchedules should still work after the failure.
    expect(listSchedules().map((s) => s.id)).toContain(schedule.id);
  });
});

/**
 * Regression alerts (ROADMAP Phase C).
 *
 * The scheduler's job here is the wiring, not the comparison: arm an evaluation
 * when a fire is submitted, run it once the batch settles, and never let any of
 * it fail a batch or stop the tick loop. `compareBatches` has its own unit tests
 * for what counts as a regression; these drive the real one through the real
 * queue and the real SQLite so the seams are exercised end to end.
 */
describe("regression alerts", () => {
  /** A schedule armed for alerts, at a time of day that never comes due. */
  function makeArmedInput(
    notify: Partial<ScheduleNotify> = {},
    overrides: Partial<CreateScheduleInput> = {},
  ): CreateScheduleInput {
    return makeInput({
      time: "23:59",
      notify: { ...DEFAULT_SCHEDULE_NOTIFY, enabled: true, ...notify },
      ...overrides,
    });
  }

  /** Fire a schedule at `score` and wait for the batch to reach a terminal state. */
  async function fireAt(
    scheduler: ReturnType<typeof createSchedulerForTests>,
    scheduleId: string,
    score: number,
  ): Promise<string> {
    nextScore = score;
    const outcome = (await scheduler.runNow(scheduleId))!;
    await waitFor(
      () => getAuditQueue().getBatch(outcome.batchId)?.status === "completed",
      `batch ${outcome.batchId} completed`,
    );
    return outcome.batchId;
  }

  it("does not double-deliver when a sweep lands inside a slow delivery (review M1)", async () => {
    // The persisted marker is written AFTER delivery, on purpose: a process
    // killed mid-POST must retry rather than lose the regression. That leaves a
    // window up to ALERT_DELIVERY_TIMEOUT_MS wide in which the minute tick would
    // read the pre-delivery marker and evaluate the same batch a second time —
    // a second POST to the user's channel and a duplicate set of rows. The
    // synchronous claim in the scheduler is what closes it.
    const schedule = createSchedule(makeArmedInput())!;
    const scheduler = createSchedulerForTests();

    const first = await fireAt(scheduler, schedule.id, 95);
    await waitFor(
      () => getAlertsEvaluatedBatchId(schedule.id) === first,
      "baseline evaluated",
    );

    // Hold the delivery open so a concurrent evaluation is guaranteed to land
    // inside the window rather than depending on timing luck.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockDeliverAlerts.mockImplementation(async () => {
      await held;
      return { attempted: true, delivered: true };
    });

    const second = await fireAt(scheduler, schedule.id, 70);
    // The queue subscription's evaluation is now parked inside deliverAlerts.
    await waitFor(
      () => mockDeliverAlerts.mock.calls.length === 1,
      "delivery in flight",
    );

    // Everything that could re-enter while it is parked: two ticks and a direct
    // re-evaluation, all racing the same batch.
    await Promise.all([
      scheduler.tick(new Date()),
      scheduler.tick(new Date()),
      evaluateBatchAlerts(schedule.id, second),
    ]);

    release();
    await waitFor(
      () => listScheduleAlerts(schedule.id).length > 0,
      "alert recorded",
    );

    // Exactly one POST, exactly one row — not one per re-entry.
    expect(mockDeliverAlerts).toHaveBeenCalledTimes(1);
    expect(listScheduleAlerts(schedule.id)).toHaveLength(1);
    expect(getAlertsEvaluatedBatchId(schedule.id)).toBe(second);
  });

  it("fires, completes, compares against the previous fire, and delivers", async () => {
    const schedule = createSchedule(makeArmedInput())!;
    const scheduler = createSchedulerForTests();

    const first = await fireAt(scheduler, schedule.id, 95);
    // Nothing to compare a first fire against — it is the baseline.
    await waitFor(
      () => getAlertsEvaluatedBatchId(schedule.id) === first,
      "first fire evaluated",
    );
    expect(mockDeliverAlerts).not.toHaveBeenCalled();
    expect(listScheduleAlerts(schedule.id)).toEqual([]);

    const second = await fireAt(scheduler, schedule.id, 70);
    await waitFor(
      () => listScheduleAlerts(schedule.id).length > 0,
      "second fire produced an alert",
    );

    expect(mockDeliverAlerts).toHaveBeenCalledTimes(1);
    const [alerts, context] = mockDeliverAlerts.mock.calls[0];
    expect(context).toEqual({
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      batchId: second,
      priorBatchId: first,
    });
    expect(alerts).toEqual([
      {
        // 95 → 70 crosses the default 90 pass bar.
        kind: "crossed_below",
        url: "https://example.com/",
        formFactor: "mobile",
        category: "performance",
        previous: 95,
        current: 70,
        delta: -25,
        threshold: 90,
      },
    ]);

    const rows = listScheduleAlerts(schedule.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "crossed_below",
      category: "performance",
      previous: 95,
      current: 70,
      batchId: second,
      priorBatchId: first,
      delivered: true,
    });
    expect(getAlertsEvaluatedBatchId(schedule.id)).toBe(second);
  });

  it("is silent when nothing moved — no webhook, no row", async () => {
    const schedule = createSchedule(makeArmedInput())!;
    const scheduler = createSchedulerForTests();

    await fireAt(scheduler, schedule.id, 95);
    const second = await fireAt(scheduler, schedule.id, 95);
    await waitFor(
      () => getAlertsEvaluatedBatchId(schedule.id) === second,
      "quiet comparison evaluated",
    );

    expect(mockDeliverAlerts).not.toHaveBeenCalled();
    expect(listScheduleAlerts(schedule.id)).toEqual([]);
  });

  it("never compares a disarmed schedule", async () => {
    const schedule = createSchedule(
      makeInput({ time: "23:59", notify: DEFAULT_SCHEDULE_NOTIFY }),
    )!;
    expect(schedule.notify.enabled).toBe(false);
    const scheduler = createSchedulerForTests();

    await fireAt(scheduler, schedule.id, 95);
    const second = await fireAt(scheduler, schedule.id, 20);
    await waitFor(
      () => getAlertsEvaluatedBatchId(schedule.id) === second,
      "disarmed fire evaluated",
    );

    expect(mockDeliverAlerts).not.toHaveBeenCalled();
    expect(listScheduleAlerts(schedule.id)).toEqual([]);
  });

  it("records a failed delivery rather than losing it, and the batch still completes", async () => {
    const schedule = createSchedule(makeArmedInput())!;
    const scheduler = createSchedulerForTests();

    await fireAt(scheduler, schedule.id, 95);
    mockDeliverAlerts.mockResolvedValue({
      attempted: true,
      delivered: false,
      reason: "webhook returned 500",
    });
    const second = await fireAt(scheduler, schedule.id, 70);
    await waitFor(
      () => listScheduleAlerts(schedule.id).length > 0,
      "failed delivery still recorded",
    );

    // The batch is unaffected by the delivery outcome.
    expect(getAuditQueue().getBatch(second)!.status).toBe("completed");
    expect(listScheduleAlerts(schedule.id)[0].delivered).toBe(false);
    expect(getAlertsEvaluatedBatchId(schedule.id)).toBe(second);
  });

  it("survives a delivery layer that throws outright", async () => {
    const schedule = createSchedule(makeArmedInput())!;
    const scheduler = createSchedulerForTests();

    await fireAt(scheduler, schedule.id, 95);
    mockDeliverAlerts.mockRejectedValue(new Error("network down"));
    const second = await fireAt(scheduler, schedule.id, 70);
    await waitFor(
      () => listScheduleAlerts(schedule.id).length > 0,
      "thrown delivery still recorded",
    );

    expect(getAuditQueue().getBatch(second)!.status).toBe("completed");
    expect(listScheduleAlerts(schedule.id)[0].delivered).toBe(false);
    // Marked anyway: the rows ARE the record, so the sweep must not retry and
    // re-post the same comparison a minute later.
    expect(getAlertsEvaluatedBatchId(schedule.id)).toBe(second);
  });

  it("never delivers the same comparison twice", async () => {
    const schedule = createSchedule(makeArmedInput())!;
    const scheduler = createSchedulerForTests();

    await fireAt(scheduler, schedule.id, 95);
    const second = await fireAt(scheduler, schedule.id, 70);
    await waitFor(
      () => listScheduleAlerts(schedule.id).length > 0,
      "first evaluation delivered",
    );
    expect(mockDeliverAlerts).toHaveBeenCalledTimes(1);

    // Both re-entry points — a direct re-evaluation and the minute sweep — are
    // no-ops once the marker names the batch.
    await evaluateBatchAlerts(schedule.id, second);
    await scheduler.tick(new Date());
    await scheduler.tick(new Date());

    expect(mockDeliverAlerts).toHaveBeenCalledTimes(1);
    expect(listScheduleAlerts(schedule.id)).toHaveLength(1);
  });

  it("the minute tick sweeps up a batch whose listener died with a restart", async () => {
    const schedule = createSchedule(makeArmedInput())!;
    const scheduler = createSchedulerForTests();
    await fireAt(scheduler, schedule.id, 95);

    // The state a restart leaves behind: the batch was submitted and the fire
    // recorded, but the in-memory subscription that would have evaluated it
    // never existed in this process. Submit it exactly as `fireSchedule` does,
    // minus the arming.
    nextScore = 70;
    const orphan = getAuditQueue().createBatch({
      urls: ["https://example.com/"],
      device: schedule.device,
      options: schedule.options,
      source: schedule.source,
      concurrency: schedule.concurrency,
      accuracyMode: schedule.accuracyMode,
      scheduleId: schedule.id,
    });
    recordScheduleFire(schedule.id, orphan.id);
    await waitFor(
      () => getAuditQueue().getBatch(orphan.id)?.status === "completed",
      "orphan batch completed",
    );
    expect(mockDeliverAlerts).not.toHaveBeenCalled();

    // A tick at a moment the schedule isn't due: the sweep is the only thing
    // that can act here.
    const notDue = new Date();
    notDue.setHours(12, 0, 0, 0);
    await scheduler.tick(notDue);

    expect(mockDeliverAlerts).toHaveBeenCalledTimes(1);
    expect(listScheduleAlerts(schedule.id)).toHaveLength(1);
    expect(getAlertsEvaluatedBatchId(schedule.id)).toBe(orphan.id);
  });

  it("a cancelled batch never alerts", async () => {
    const schedule = createSchedule(
      makeArmedInput({}, {
        target: { kind: "urls", urls: ["https://a.test/", "https://b.test/"] },
        concurrency: 1,
      }),
    )!;
    const scheduler = createSchedulerForTests();

    // Baseline fire, then a second one paused part-way through.
    nextScore = 95;
    const first = (await scheduler.runNow(schedule.id))!;
    await waitFor(
      () => getAuditQueue().getBatch(first.batchId)?.status === "completed",
      "baseline completed",
    );

    nextScore = 20;
    blockJobs((url) => url === "https://b.test/");
    const second = (await scheduler.runNow(schedule.id))!;
    await waitFor(() => {
      const counts = getAuditQueue().getBatch(second.batchId)?.counts;
      return counts?.done === 1 && counts.running === 1;
    }, "a done, b running");
    scheduler.cancelActiveBatches(schedule.id);
    await drainQueue();

    // A paused batch holds a partial URL set; comparing it would report every
    // unaudited page as a change.
    expect(mockDeliverAlerts).not.toHaveBeenCalled();
    expect(listScheduleAlerts(schedule.id)).toEqual([]);
    // And the tick sweep agrees — a cancelled batch is not a comparable one.
    await scheduler.tick(new Date());
    expect(mockDeliverAlerts).not.toHaveBeenCalled();
  });

  it("watches only the categories the schedule selected", async () => {
    const schedule = createSchedule(makeArmedInput({ categories: ["seo"] }))!;
    const scheduler = createSchedulerForTests();

    await fireAt(scheduler, schedule.id, 95);
    const second = await fireAt(scheduler, schedule.id, 20);
    await waitFor(
      () => getAlertsEvaluatedBatchId(schedule.id) === second,
      "narrowed comparison evaluated",
    );

    // Performance collapsed, but this schedule only watches SEO.
    expect(mockDeliverAlerts).not.toHaveBeenCalled();
    expect(listScheduleAlerts(schedule.id)).toEqual([]);
  });

  it("an alert failure never stops the tick loop or a sibling schedule's fire", async () => {
    const armed = createSchedule(makeArmedInput({}, { name: "armed" }))!;
    const scheduler = createSchedulerForTests();
    await fireAt(scheduler, armed.id, 95);
    mockDeliverAlerts.mockRejectedValue(new Error("network down"));
    await fireAt(scheduler, armed.id, 70);

    // A schedule that IS due, created after the armed one so the tick reaches
    // it while the failing evaluation is still in play.
    const due = createSchedule(makeInput({ name: "due", time: "09:00" }))!;
    mockRunAudit.mockClear();
    await scheduler.tick(new Date(2026, 4, 28, 9, 0, 0, 0));
    await drainQueue();

    expect(getSchedule(due.id)!.lastBatchId).not.toBeNull();
    expect(mockRunAudit).toHaveBeenCalled();
  });
});
