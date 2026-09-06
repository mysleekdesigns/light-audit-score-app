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
 *
 * ## Regression alerts (ROADMAP Phase C)
 *
 * Phase 14 built this whole loop and it notified nobody. What closes that is
 * {@link evaluateBatchAlerts}: compare a finished fire against the schedule's
 * previous one, deliver what changed, persist it.
 *
 * The plan puts delivery "after `recordScheduleFire`", and the shape that has to
 * take is worth spelling out: `recordScheduleFire` runs at *fire* time, when the
 * batch has not audited a single URL, so what happens there is **arming**, not
 * sending. Two paths then reach the evaluation, because either alone has a hole:
 *
 *  - **The queue subscription** ({@link armAlertEvaluation}) evaluates the moment
 *    the batch emits `batch-completed`. Immediate, but purely in-memory — a
 *    server restart mid-batch loses the listener.
 *  - **The minute tick** ({@link sweepScheduleAlerts}) re-checks every schedule
 *    whose most recent batch has finished and not yet been evaluated. Slower, but
 *    it survives a restart.
 *
 * Both converge on the same function, so `alerts_evaluated_batch_id` is the
 * idempotence marker that makes the overlap harmless: evaluating a batch twice
 * delivers nothing the second time.
 *
 * Nothing in the alert path may fail a batch or stop the tick loop — an audit
 * that succeeded must not be undone by a webhook that didn't. Every entry point
 * catches, warns, and moves on.
 */

import { compareBatches } from "@/lib/alerts/compare";
import { deliverAlerts } from "@/lib/alerts/deliver";
import {
  previousCompletedBatchId,
  readBatchRunScores,
  recordAlerts,
} from "@/lib/db/alerts";
import { reconstructBatch } from "@/lib/db/persistence";
import {
  getAlertsEvaluatedBatchId,
  getSchedule,
  listSchedules,
  markAlertsEvaluated,
  recordScheduleFire,
} from "@/lib/db/schedules";
import { discover } from "@/lib/crawl/discover";
import { resolveFormFactors } from "@/lib/lighthouse/options";
import type { FormFactor } from "@/lib/lighthouse/types";
import { getAuditQueue } from "@/lib/queue/AuditQueue";
import type { Batch, BatchStatus, ProgressListener } from "@/lib/queue/types";
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

// --- Regression alerts (ROADMAP Phase C) -----------------------------------

/** Batch statuses whose run set is final and complete enough to compare. */
function isComparableStatus(status: BatchStatus): boolean {
  return status === "completed" || status === "completed_with_errors";
}

/**
 * Evaluations in flight, keyed `scheduleId:batchId`.
 *
 * `alerts_evaluated_batch_id` is the marker that survives a restart, but it is
 * written *after* delivery — deliberately, so a process killed mid-POST retries
 * on the next sweep rather than losing the regression silently. That leaves a
 * window: delivery may block for up to `ALERT_DELIVERY_TIMEOUT_MS`, and a minute
 * tick landing inside it would read the old marker and evaluate the same batch a
 * second time, posting the same alerts to the channel twice and writing a
 * duplicate set of rows.
 *
 * This closes that window the only way an in-process race can be closed: a claim
 * taken **synchronously**, before the first `await`, and released in a `finally`.
 * Both entry points (the queue subscription and the sweep) run in this one
 * process, so a Set is sufficient; it is deliberately not a substitute for the
 * persisted marker, which covers the restart case a Set cannot.
 */
const evaluating = new Set<string>();

/**
 * Compare a finished batch against the schedule's previous fire, deliver what
 * changed, and record it.
 *
 * Exported so tests (and the two callers below) can drive one evaluation
 * directly. Idempotent in both halves it needs to be: {@link evaluating} rejects
 * a re-entry while one is still in flight, and `alerts_evaluated_batch_id`
 * rejects one after the fact (including across a restart). That is what lets the
 * queue subscription and the minute-tick sweep both point at this without ever
 * risking a duplicate webhook.
 *
 * **Quiet means silent.** When the comparison finds nothing, the batch is marked
 * evaluated and that is all — no webhook call, no row, no log line. A monitoring
 * tool that announces every uneventful night trains its user to ignore it.
 *
 * Never throws: an alert is a note about work that already succeeded, so a
 * failure here is logged and the batch, the fire and the tick loop carry on.
 */
export async function evaluateBatchAlerts(
  scheduleId: string,
  batchId: string,
): Promise<void> {
  try {
    // Re-read rather than taking a Schedule argument: the config may have been
    // edited between the fire and the batch finishing, and the run that just
    // completed should be judged by the rules in force now.
    const schedule = getSchedule(scheduleId);
    if (!schedule) return;
    if (getAlertsEvaluatedBatchId(scheduleId) === batchId) return;

    // Claim before the first await (see `evaluating`). Everything from here to
    // the `finally` is one logical evaluation of this batch.
    const claim = `${scheduleId}:${batchId}`;
    if (evaluating.has(claim)) return;
    evaluating.add(claim);
    try {
      await evaluateClaimedBatch(schedule, scheduleId, batchId);
    } finally {
      evaluating.delete(claim);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[scheduler] alert evaluation for schedule ${scheduleId} failed: ${message}`,
    );
  }
}

/**
 * The body of one claimed evaluation: compare, deliver, record, mark.
 *
 * Split out of {@link evaluateBatchAlerts} purely so the claim/release pair
 * around it stays a single readable `try`/`finally` rather than being threaded
 * through every early return below.
 */
async function evaluateClaimedBatch(
  schedule: Schedule,
  scheduleId: string,
  batchId: string,
): Promise<void> {
  if (!schedule.notify.enabled) {
    // Marked, not just skipped. Arming alerts must not retro-fire on a fire
    // that completed while the schedule was disarmed — the user armed them to
    // hear about the *next* regression, not this morning's — and the marker
    // also stops the minute sweep re-reading this batch forever.
    markAlertsEvaluated(scheduleId, batchId);
    return;
  }

  const priorBatchId = previousCompletedBatchId(scheduleId, batchId);
  if (!priorBatchId) {
    // A schedule's first fire has nothing to compare against; it is the
    // baseline the *next* one is judged by.
    markAlertsEvaluated(scheduleId, batchId);
    return;
  }

  const alerts = compareBatches(
    readBatchRunScores(priorBatchId),
    readBatchRunScores(batchId),
    schedule.notify,
  );
  if (alerts.length === 0) {
    markAlertsEvaluated(scheduleId, batchId);
    return;
  }

  // Delivery is the one step that talks to the outside world, so it gets its
  // own guard: a webhook that times out, 500s or throws must still leave the
  // comparison recorded. `deliverAlerts` reports an ordinary failure as
  // `delivered: false`; this catch covers the case where it doesn't get that
  // far at all.
  let delivered = false;
  try {
    const result = await deliverAlerts(alerts, {
      scheduleId,
      scheduleName: schedule.name,
      batchId,
      priorBatchId,
    });
    delivered = result.delivered;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[scheduler] alert delivery for schedule ${scheduleId} failed: ${message}`,
    );
  }
  // Persist either way, and mark evaluated either way: the rows ARE the
  // record (the Archive strip reads them with no webhook configured at all),
  // so a delivery failure must not queue a retry that re-posts tomorrow's
  // comparison twice.
  recordAlerts(scheduleId, batchId, priorBatchId, alerts, delivered);
  markAlertsEvaluated(scheduleId, batchId);
}

/**
 * Subscribe to a just-fired batch and evaluate its alerts the moment it
 * completes.
 *
 * The listener unsubscribes on either terminal event, so it can never leak:
 * `batch-completed` evaluates and detaches; `batch-cancelled` only detaches,
 * because a paused batch holds results for whichever URLs happened to finish
 * first and comparing that partial set would report every unaudited page as a
 * change.
 */
function armAlertEvaluation(scheduleId: string, batchId: string): void {
  try {
    let unsubscribe: (() => void) | null = null;
    const detach = (): void => {
      unsubscribe?.();
      unsubscribe = null;
    };
    const listener: ProgressListener = (event) => {
      if (event.type === "batch-completed") {
        detach();
        void evaluateBatchAlerts(scheduleId, batchId);
      } else if (event.type === "batch-cancelled") {
        detach();
      }
    };
    unsubscribe = getAuditQueue().subscribe(batchId, listener);
  } catch (err) {
    // The tick sweep is the backstop, so a failed subscription costs latency,
    // not the alert.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[scheduler] arming alerts for batch ${batchId} failed: ${message}`,
    );
  }
}

/**
 * Minute-tick backstop for {@link armAlertEvaluation}: evaluate a schedule whose
 * most recent batch has finished but was never evaluated — the state left behind
 * when the server restarted while a batch was in flight, taking the in-memory
 * subscription with it.
 *
 * Cheap in the common case: the marker check short-circuits before the batch is
 * looked up at all, so a schedule whose alerts are already settled costs one
 * indexed read per tick.
 */
async function sweepScheduleAlerts(schedule: Schedule): Promise<void> {
  const batchId = schedule.lastBatchId;
  if (!batchId) return;
  if (getAlertsEvaluatedBatchId(schedule.id) === batchId) return;
  // `findBatch` prefers the live queue and falls back to the persisted index,
  // which is exactly the batch a restart left behind.
  const batch = findBatch(batchId);
  if (!batch || !isComparableStatus(batch.status)) return;
  await evaluateBatchAlerts(schedule.id, batchId);
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
    // Arm the regression comparison for this fire. Nothing is compared yet — the
    // batch has not audited a URL — so this only attaches the listener that runs
    // the comparison once the batch settles.
    armAlertEvaluation(schedule.id, batch.id);
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
      // Sweep BEFORE firing: a due schedule is about to overwrite `lastBatchId`,
      // and the batch that pointer currently names is the one still owed an
      // alert comparison.
      await sweepScheduleAlerts(schedule);
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
