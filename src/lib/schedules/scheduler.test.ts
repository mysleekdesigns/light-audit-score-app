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
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the process-isolated audit runner so the queue never launches Chrome.
vi.mock("@/lib/queue/runAuditWorker", () => ({ runAuditInWorker: vi.fn() }));
// Mock discovery so a crawl target's resolveUrls() doesn't hit the network.
vi.mock("@/lib/crawl/discover", () => ({ discover: vi.fn() }));

const { runAuditInWorker } = await import("@/lib/queue/runAuditWorker");
const { discover } = await import("@/lib/crawl/discover");
const { resetDbForTests } = await import("@/lib/db/client");
const { createSchedule, getSchedule, listSchedules } = await import(
  "@/lib/db/schedules"
);
const { createSchedulerForTests, fireSchedule } = await import(
  "@/lib/schedules/scheduler"
);

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

import type { AuditResult } from "@/lib/lighthouse/types";
import { DEFAULT_OPTIONS } from "@/lib/lighthouse/options";
import type { CreateScheduleInput } from "@/lib/schedules/types";

const mockRunAudit = vi.mocked(runAuditInWorker);
const mockDiscover = vi.mocked(discover);

function makeResult(url: string): AuditResult {
  return {
    requestedUrl: url,
    finalUrl: url,
    options: DEFAULT_OPTIONS,
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
      lhr: { fake: true },
    },
    perRunScores: [{ performance: 90 }],
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
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-sched-"));
  process.env.LH_DATA_DIR = tmpDir;
  process.env.LH_DB_PATH = path.join(tmpDir, "test.db");
  resetDbForTests();
  mockRunAudit.mockReset();
  mockRunAudit.mockImplementation((url) => Promise.resolve(makeResult(url)));
  mockDiscover.mockReset();
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

    const batchId = await scheduler.runNow(schedule.id);
    await drainQueue();
    expect(batchId).not.toBeNull();
    expect(typeof batchId).toBe("string");
    expect(mockRunAudit).toHaveBeenCalledTimes(1);
    // The schedule's row reflects the forced fire.
    expect(getSchedule(schedule.id)!.lastBatchId).toBe(batchId);
  });

  it("returns null for an unknown schedule id without firing anything", async () => {
    const scheduler = createSchedulerForTests();
    const batchId = await scheduler.runNow("does-not-exist");
    expect(batchId).toBeNull();
    expect(mockRunAudit).not.toHaveBeenCalled();
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
