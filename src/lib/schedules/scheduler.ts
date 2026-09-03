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
 * Pause / resume: `POST /api/schedules/:id/pause` calls
 * {@link Scheduler.cancelActiveBatches} — the batch in flight is cancelled
 * through the queue (workers killed, finished runs kept) and the schedule's
 * daily cadence is left alone. "Run now" then fires with `resume: true`, which
 * skips every URL that already produced a result in the paused batch (following
 * the chain of `priorBatchId` links when a resumed run is itself paused), so the
 * schedule picks up where it left off. The cadence tick never resumes: a daily
 * fire is always a full run of the target.
 *
 * Pure cadence math lives in {@link shouldFireNow} (cadence.ts) so the scheduler
 * can be tested with a fast-forwarded clock (PRD Phase 14 Verify).
 */

import { reconstructBatch } from "@/lib/db/persistence";
import {
  getSchedule,
  listSchedules,
  recordScheduleFire,
} from "@/lib/db/schedules";
import { discover } from "@/lib/crawl/discover";
import { resolveFormFactors } from "@/lib/lighthouse/options";
import type { FormFactor } from "@/lib/lighthouse/types";
import { getAuditQueue } from "@/lib/queue/AuditQueue";
import type { Batch } from "@/lib/queue/types";
import { shouldFireNow } from "@/lib/schedules/cadence";
import type { Schedule } from "@/lib/schedules/types";

const TICK_MS = 60_000;

/**
 * Upper bound on how many paused batches a resume walks back through. A chain
 * only grows by one per pause/resume cycle, so this is far beyond real use; it
 * just guarantees termination if lineage rows were ever hand-edited into a loop.
 */
const MAX_RESUME_CHAIN = 25;

/** A scheduler tick is asynchronous because a crawl target needs discovery. */
type Tick = (now?: Date) => Promise<void>;

/** What a fire produced. */
export interface FireOutcome {
  /** Id of the batch submitted to the queue. */
  batchId: string;
  /** Number of URLs submitted in this batch. */
  urlCount: number;
  /**
   * Id of the paused (cancelled) batch this fire resumed, or `null` for a full
   * fire. Recorded on the new batch as `priorBatchId` for lineage.
   */
  resumedFrom: string | null;
  /** URLs left out because the paused batch chain already holds their result. */
  skipped: number;
}

export interface FireOptions {
  /**
   * When true, skip URLs already audited by the schedule's paused batch (see
   * {@link completedUrlsOfPausedRun}). Defaults to false — a full fire.
   */
  resume?: boolean;
}

export interface Scheduler {
  /** Start the minute-tick loop (idempotent). Returns this scheduler for chaining. */
  start(): Scheduler;
  /** Stop the loop (idempotent). Used by tests for isolation. */
  stop(): void;
  /**
   * Force-fire a single schedule by id, ignoring cadence. Resumes the schedule's
   * paused run when there is one. Returns the outcome, or null.
   */
  runNow(scheduleId: string): Promise<FireOutcome | null>;
  /**
   * Cancel every batch this schedule has in flight (queued or running). Returns
   * the cancelled snapshots; empty when nothing was running. Idempotent.
   */
  cancelActiveBatches(scheduleId: string): Batch[];
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
 * A batch by id: the live queue first (it alone knows about jobs still queued
 * or running), else the persisted index (a batch from before a server restart,
 * whose settled runs are all that survive).
 */
function findBatch(id: string): Batch | undefined {
  return getAuditQueue().getBatch(id) ?? reconstructBatch(id);
}

/**
 * The URLs (per form factor) a schedule's paused run already finished. Walks
 * back from the schedule's most recent batch along `priorBatchId` for as long as
 * each link is a cancelled batch this schedule fired — a resumed run that was
 * paused again links to the run it resumed, so results from every leg count.
 * `resumedFrom` is the most recent paused batch, or null when the latest batch
 * is not a paused one (nothing to resume).
 */
function completedUrlsOfPausedRun(schedule: Schedule): {
  done: Map<string, Set<FormFactor>>;
  resumedFrom: string | null;
} {
  const done = new Map<string, Set<FormFactor>>();
  let resumedFrom: string | null = null;
  let id: string | null = schedule.lastBatchId;
  for (let depth = 0; id && depth < MAX_RESUME_CHAIN; depth++) {
    const batch = findBatch(id);
    if (
      !batch ||
      batch.status !== "cancelled" ||
      batch.scheduleId !== schedule.id
    ) {
      break;
    }
    resumedFrom ??= batch.id;
    for (const job of batch.jobs) {
      if (job.status !== "done") continue;
      let formFactors = done.get(job.url);
      if (!formFactors) {
        formFactors = new Set();
        done.set(job.url, formFactors);
      }
      formFactors.add(job.device);
    }
    id = batch.priorBatchId ?? null;
  }
  return { done, resumedFrom };
}

/**
 * Fire a single schedule: resolve its URLs, submit the batch through the queue
 * with `scheduleId` set, then record the fire. With `resume`, URLs the paused
 * run already finished are left out and the new batch links back to it via
 * `priorBatchId`. Never throws — a fire failure is logged and swallowed so a
 * single broken schedule can't stop the loop.
 */
export async function fireSchedule(
  schedule: Schedule,
  options: FireOptions = {},
): Promise<FireOutcome | null> {
  try {
    const urls = await resolveUrls(schedule);
    if (urls.length === 0) {
      console.warn(
        `[scheduler] schedule ${schedule.id} resolved to 0 URLs; skipping`,
      );
      return null;
    }

    let submit = urls;
    let resumedFrom: string | null = null;
    if (options.resume) {
      const paused = completedUrlsOfPausedRun(schedule);
      if (paused.resumedFrom) {
        // A URL is finished only once every form factor the schedule runs has a
        // result; a "both" URL with just its mobile leg done runs again in full.
        const formFactors = resolveFormFactors(schedule.device);
        const remaining = urls.filter((url) => {
          const finished = paused.done.get(url);
          return !(finished && formFactors.every((ff) => finished.has(ff)));
        });
        // Every URL already has a result (the target shrank, say): there is
        // nothing to pick up, so fall through to an ordinary full fire.
        if (remaining.length > 0) {
          submit = remaining;
          resumedFrom = paused.resumedFrom;
        }
      }
    }

    const batch = getAuditQueue().createBatch({
      urls: submit,
      device: schedule.device,
      options: schedule.options,
      source: schedule.source,
      concurrency: schedule.concurrency,
      accuracyMode: schedule.accuracyMode,
      scheduleId: schedule.id,
      priorBatchId: resumedFrom ?? undefined,
    });
    recordScheduleFire(schedule.id, batch.id);
    return {
      batchId: batch.id,
      urlCount: submit.length,
      resumedFrom,
      skipped: urls.length - submit.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[scheduler] firing schedule ${schedule.id} failed: ${message}`);
    return null;
  }
}

function createScheduler(): Scheduler {
  let interval: ReturnType<typeof setInterval> | null = null;

  /**
   * Batches fired per schedule and not yet known to have settled. Lets a pause
   * stop every run in flight, not only the schedule's `lastBatchId` (a second
   * "Run now" while the first is still going starts a second batch). Pruned as
   * batches are found terminal; the process owns the queue, so a restart loses
   * nothing that was still cancellable.
   */
  const inFlight = new Map<string, Set<string>>();

  const track = (scheduleId: string, batchId: string): void => {
    let ids = inFlight.get(scheduleId);
    if (!ids) {
      ids = new Set();
      inFlight.set(scheduleId, ids);
    }
    ids.add(batchId);
  };

  const fire = async (
    schedule: Schedule,
    options?: FireOptions,
  ): Promise<FireOutcome | null> => {
    const outcome = await fireSchedule(schedule, options);
    if (outcome) track(schedule.id, outcome.batchId);
    return outcome;
  };

  const tick: Tick = async (now: Date = new Date()) => {
    const schedules = listSchedules();
    for (const schedule of schedules) {
      if (!shouldFireNow(schedule, now)) continue;
      await fire(schedule);
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
      const schedule = getSchedule(scheduleId);
      if (!schedule) return null;
      return await fire(schedule, { resume: true });
    },
    cancelActiveBatches(scheduleId) {
      const ids = new Set(inFlight.get(scheduleId) ?? []);
      // The persisted pointer covers a batch fired before this singleton was
      // (re)created — dev-mode module reloads, mostly.
      const lastBatchId = getSchedule(scheduleId)?.lastBatchId;
      if (lastBatchId) ids.add(lastBatchId);

      const queue = getAuditQueue();
      const cancelled: Batch[] = [];
      for (const id of ids) {
        const live = queue.getBatch(id);
        if (
          live &&
          live.scheduleId === scheduleId &&
          (live.status === "queued" || live.status === "running")
        ) {
          const snapshot = queue.cancelBatch(id);
          if (snapshot) cancelled.push(snapshot);
        }
        // Unknown, foreign, or terminal either way: nothing left to stop.
        inFlight.get(scheduleId)?.delete(id);
      }
      return cancelled;
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
