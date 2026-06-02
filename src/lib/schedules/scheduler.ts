/**
 * Local scheduler — fires saved schedules through the existing audit queue
 * (PRD §6 Phase 14).
 *
 * Single-user local tool: no Redis / cron / external broker (PRD §5). We pin a
 * tiny tick singleton on `globalThis` (same HMR-safe pattern as `AuditQueue` /
 * the DB client), call `start()` from `instrumentation.ts` at server boot, and
 * fire any due schedules every minute. Firing reuses the existing `AuditQueue.createBatch`
 * path — schedules are just a new caller, not a new queue.
 *
 * Pure cadence math lives in {@link shouldFireNow} (cadence.ts) so the scheduler
 * can be tested with a fast-forwarded clock (PRD Phase 14 Verify).
 */

import { recordScheduleFire } from "@/lib/db/schedules";
import { listSchedules } from "@/lib/db/schedules";
import { discover } from "@/lib/crawl/discover";
import { getAuditQueue } from "@/lib/queue/AuditQueue";
import { shouldFireNow } from "@/lib/schedules/cadence";
import type { Schedule } from "@/lib/schedules/types";

const TICK_MS = 60_000;

/** A scheduler tick is asynchronous because a crawl target needs discovery. */
type Tick = (now?: Date) => Promise<void>;

export interface Scheduler {
  /** Start the minute-tick loop (idempotent). Returns this scheduler for chaining. */
  start(): Scheduler;
  /** Stop the loop (idempotent). Used by tests for isolation. */
  stop(): void;
  /** Force-fire a single schedule by id, ignoring cadence. Returns the batch id, or null. */
  runNow(scheduleId: string): Promise<string | null>;
  /** Inspect / drive cadence directly from tests. */
  tick: Tick;
  /** True once `start()` has been called and not yet stopped. */
  isRunning(): boolean;
}

/** Resolve a schedule's target into a concrete URL list for this fire. */
async function resolveUrls(schedule: Schedule): Promise<string[]> {
  if (schedule.target.kind === "urls") {
    return [...schedule.target.urls];
  }
  // Crawl target: re-resolve discovery each fire (the whole point of a daily
  // archive is to track an evolving site). Bounds + excludePaths come straight
  // off the persisted spec; `discover()` is best-effort and never throws.
  const result = await discover({
    url: schedule.target.spec.url,
    useSitemap: schedule.target.spec.useSitemap,
    useCrawl: schedule.target.spec.useCrawl,
    maxDepth: schedule.target.spec.maxDepth,
    maxPages: schedule.target.spec.maxPages,
    excludePaths: schedule.target.spec.excludePaths,
  });
  return result.urls.map((u) => u.url);
}

/**
 * Fire a single schedule: resolve its URLs, submit the batch through the queue
 * with `scheduleId` set, then record the fire. Never throws — a fire failure is
 * logged and swallowed so a single broken schedule can't stop the loop.
 */
export async function fireSchedule(schedule: Schedule): Promise<string | null> {
  try {
    const urls = await resolveUrls(schedule);
    if (urls.length === 0) {
      console.warn(
        `[scheduler] schedule ${schedule.id} resolved to 0 URLs; skipping`,
      );
      return null;
    }
    const batch = getAuditQueue().createBatch({
      urls,
      device: schedule.device,
      options: schedule.options,
      source: schedule.source,
      concurrency: schedule.concurrency,
      accuracyMode: schedule.accuracyMode,
      scheduleId: schedule.id,
    });
    recordScheduleFire(schedule.id, batch.id);
    return batch.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[scheduler] firing schedule ${schedule.id} failed: ${message}`);
    return null;
  }
}

function createScheduler(): Scheduler {
  let interval: ReturnType<typeof setInterval> | null = null;

  const tick: Tick = async (now: Date = new Date()) => {
    const schedules = listSchedules();
    for (const schedule of schedules) {
      if (!shouldFireNow(schedule, now)) continue;
      await fireSchedule(schedule);
    }
  };

  return {
    start() {
      if (interval !== null) return this;
      // Run an immediate tick at boot so a schedule whose HH:MM passed while the
      // server was down catches up rather than waiting until the next day.
      void tick();
      interval = setInterval(() => {
        void tick();
      }, TICK_MS);
      // Allow Node to exit even though the interval is open (tests / CLI).
      if (typeof interval === "object" && interval !== null && "unref" in interval) {
        (interval as { unref: () => void }).unref();
      }
      return this;
    },
    stop() {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    },
    async runNow(scheduleId) {
      const all = listSchedules();
      const schedule = all.find((s) => s.id === scheduleId);
      if (!schedule) return null;
      return await fireSchedule(schedule);
    },
    tick,
    isRunning() {
      return interval !== null;
    },
  };
}

/**
 * HMR-safe global singleton. Mirrors `getAuditQueue()` / `getDb()`.
 */
const globalForScheduler = globalThis as typeof globalThis & {
  __auditScheduler?: Scheduler;
};

/** The shared {@link Scheduler}. Lazily created on first access. */
export function getScheduler(): Scheduler {
  return (globalForScheduler.__auditScheduler ??= createScheduler());
}

/** Tests construct a fresh scheduler so each case is isolated. */
export function createSchedulerForTests(): Scheduler {
  return createScheduler();
}
