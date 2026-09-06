/**
 * Persistence layer — the seam between the audit queue, the report/history API,
 * and the History UI (PRD §6 Phase 4).
 *
 * Responsibilities:
 *  - `recordBatch` / `updateBatchStatus` — index a batch and track its lifecycle.
 *  - `recordRun` — on a successful job: write the raw LHR JSON **and** a rendered
 *    standalone Lighthouse HTML report to `./data/reports/`, then index the run
 *    row (median scores as sortable columns, metrics/options as JSON, report
 *    filenames). `recordFailedRun` indexes a failed job (scores/reports null).
 *  - `listHistory` — every persisted run, newest first, for the History table.
 *  - `getRunReport` — a run's stored report file paths, for `GET /api/reports/:runId`.
 *
 * Design notes:
 *  - **Never throws.** Persistence is a side effect of auditing; a DB/disk error
 *    must not fail an audit that already succeeded in-memory. Every export is
 *    wrapped so failures are logged and swallowed (reads degrade to empty).
 *  - **HTML is best-effort.** The JSON report (raw LHR) is always written; the
 *    HTML report is generated via Lighthouse's `ReportGenerator` (dynamic import,
 *    same as the legacy report route) and any failure there leaves `reportHtml`
 *    null without affecting the JSON path or the row.
 *  - **Sync where it can be.** `better-sqlite3` is synchronous, so DB writes/reads
 *    are sync; only file IO + the HTML generator make `recordRun` async.
 *  - **Nothing credential-shaped is written down.** Audit credentials (ROADMAP
 *    Phase B) belong to the site under audit, not to LightAudit Score, so every
 *    write here passes its options through `redactAuditOptions` — names kept as
 *    provenance, values replaced — and `recordRun` scrubs the LHR before the
 *    report file is written. Both are idempotent backstops behind the queue's
 *    structural guarantee (credentials never reach a `Batch` at all); this layer
 *    is what makes a *future* caller unable to persist one by accident.
 */

import { promises as fs } from "node:fs";

import { desc, eq } from "drizzle-orm";

import { deleteAllAnalyses, deleteAnalysesForRun } from "@/lib/db/analyses";
import { getDb } from "@/lib/db/client";
import {
  getReportsDir,
  reportHtmlFilename,
  reportHtmlPath,
  reportJsonFilename,
  reportJsonPath,
} from "@/lib/db/paths";
import {
  batches,
  runs,
  scheduleAlerts,
  schedules,
  type BatchRow,
  type RunRow,
} from "@/lib/db/schema";
import {
  redactAuditOptions,
  scrubLhrCredentials,
} from "@/lib/lighthouse/credentials";
import type {
  AuditOptions,
  AuditResult,
  AuditSource,
  CategoryScores,
  CoreWebVitals,
  DeviceSelection,
  FieldData,
  FormFactor,
  RunEnvironment,
} from "@/lib/lighthouse/types";
import type {
  AuditJob,
  AuditResultLite,
  Batch,
  BatchCounts,
  BatchStatus,
} from "@/lib/queue/types";

/** A persisted run flattened for the History table (newest-first listing). */
export interface HistoryRow {
  /** Run id (== report runId). */
  id: string;
  batchId: string;
  url: string;
  finalUrl: string | null;
  status: "done" | "error";
  errorMessage: string | null;
  formFactor: FormFactor;
  /** Engine that produced this run ("local" | "psi"); defaults to "local" for legacy rows. */
  source: AuditSource;
  /** Number of runs the median was taken over (null for failures). */
  runs: number | null;
  /**
   * Resolved {@link AuditOptions} the run used (parsed from the row's options JSON).
   * Lets a Re-run (PRD §6 Phase 13) reproduce a single page with full fidelity
   * (categories / throttling / cpu multiplier), not just its device. Falls back to
   * a minimal mobile/simulated default if the column can't be parsed.
   */
  options: AuditOptions;
  /** Median category scores (0–100), assembled from the row's score columns. */
  scores: CategoryScores;
  /** Median Core Web Vitals (parsed from the row's JSON; null for failures). */
  metrics: CoreWebVitals | null;
  /** Real-world CrUX field data (PSI runs only; null for local runs/failures). */
  field: FieldData | null;
  /**
   * Host / effective-throttling environment of the median run (PRD §6 Phase 10):
   * `benchmarkIndex` ("CPU/Memory Power"), the effective throttling method, and the
   * applied CPU multiplier. Null for failed runs and for rows persisted before the
   * Phase 10 migration (so the environment badge / drift warning degrade gracefully).
   */
  environment: RunEnvironment | null;
  /** Whether a stored JSON / HTML report exists for this run. */
  hasJsonReport: boolean;
  hasHtmlReport: boolean;
  /** ISO fetchTime from the median LHR (null for failures). */
  fetchTime: string | null;
  /** ISO timestamp the row was persisted. */
  createdAt: string;
}

/** A persisted batch's metadata (for the batch-summary view), newest first. */
export interface BatchInfo {
  id: string;
  status: BatchStatus;
  /** Engine that ran the batch ("local" | "psi"); defaults to "local" for legacy rows. */
  source: AuditSource;
  /** Resolved options the batch ran with. */
  options: AuditOptions;
  /** Resolved (clamped) concurrency the batch ran at. */
  concurrency: number;
  /** Number of jobs in the batch. */
  total: number;
  /**
   * The batch this one re-runs (PRD §6 Phase 13), or null for a fresh batch.
   * Surfaced so a re-run card can show its lineage.
   */
  priorBatchId: string | null;
  /**
   * The schedule that fired this batch (PRD §6 Phase 14), or null for ad-hoc batches.
   * The Archive view groups batches by `scheduleId` for day-over-day trends.
   */
  scheduleId: string | null;
  /** ISO timestamps for the batch lifecycle. */
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A run's stored report file locations, for the report endpoint. */
export interface RunReport {
  id: string;
  url: string;
  /** Absolute path to the raw LHR JSON, or null if not stored. */
  jsonPath: string | null;
  /** Absolute path to the standalone HTML report, or null if not stored. */
  htmlPath: string | null;
}

/** Log + swallow a persistence failure (never propagate to the caller). */
function warn(op: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[persistence] ${op} failed: ${message}`);
}

/** Round a 0–100 score to an int column value, mapping null/undefined/NaN → null. */
function toScoreInt(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.round(value);
}

/** Current ISO timestamp. */
function nowIso(): string {
  return new Date().toISOString();
}

// --- Batch lifecycle -------------------------------------------------------

/** Index a freshly-created batch. Idempotent (no-op if the id already exists). */
export function recordBatch(batch: Batch): void {
  try {
    getDb()
      .insert(batches)
      .values({
        id: batch.id,
        status: batch.status,
        source: batch.source,
        options: JSON.stringify(redactAuditOptions(batch.options)),
        concurrency: batch.concurrency,
        total: batch.jobs.length,
        priorBatchId: batch.priorBatchId ?? null,
        scheduleId: batch.scheduleId ?? null,
        createdAt: batch.createdAt,
        startedAt: batch.startedAt ?? null,
        finishedAt: batch.finishedAt ?? null,
      })
      .onConflictDoNothing()
      .run();
  } catch (err) {
    warn("recordBatch", err);
  }
}

/** Patch a batch's lifecycle status / timestamps. */
export function updateBatchStatus(
  batchId: string,
  patch: { status: BatchStatus; startedAt?: string; finishedAt?: string },
): void {
  try {
    const set: Partial<{
      status: string;
      startedAt: string;
      finishedAt: string;
    }> = { status: patch.status };
    if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
    if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
    getDb().update(batches).set(set).where(eq(batches.id, batchId)).run();
  } catch (err) {
    warn("updateBatchStatus", err);
  }
}

// --- Run persistence -------------------------------------------------------

/**
 * Persist a successful run: write the JSON (raw LHR) and best-effort HTML report
 * files, then index the run row. Never throws.
 */
export async function recordRun(
  batch: Batch,
  job: AuditJob,
  result: AuditResult,
): Promise<void> {
  try {
    await fs.mkdir(getReportsDir(), { recursive: true });

    // Belt-and-braces credential scrub (ROADMAP Phase B). Lighthouse copies its
    // resolved settings into the report verbatim, so an authenticated run's
    // `Authorization`/`Cookie` header would otherwise be written into the JSON
    // report, embedded in the HTML one, and read back by the AI analysis. The
    // worker already scrubs before the LHR crosses the process boundary; this is
    // the last gate before the value would land on disk, and it is idempotent.
    scrubLhrCredentials(result.median.lhr);

    // Raw LHR JSON — exactly what `GET /api/reports/:runId` (default) serves.
    await fs.writeFile(
      reportJsonPath(job.id),
      JSON.stringify(result.median.lhr),
      "utf8",
    );

    // Standalone HTML report — best effort; failure leaves reportHtml null.
    let htmlFilename: string | null = null;
    try {
      const html = await generateHtmlReport(result.median.lhr);
      await fs.writeFile(reportHtmlPath(job.id), html, "utf8");
      htmlFilename = reportHtmlFilename(job.id);
    } catch (err) {
      warn("recordRun:html", err);
    }

    const scores = result.median.scores;
    getDb()
      .insert(runs)
      .values({
        id: job.id,
        batchId: batch.id,
        idx: job.index,
        url: result.requestedUrl || job.url,
        finalUrl: result.finalUrl ?? null,
        status: "done",
        source: result.source ?? batch.source,
        errorMessage: null,
        formFactor: result.options.formFactor,
        throttling: result.options.throttling,
        runs: result.runs,
        lighthouseVersion: result.lighthouseVersion,
        scorePerformance: toScoreInt(scores.performance),
        scoreAccessibility: toScoreInt(scores.accessibility),
        scoreBestPractices: toScoreInt(scores["best-practices"]),
        scoreSeo: toScoreInt(scores.seo),
        // Lighthouse 13.3's fifth category. `toScoreInt` maps an absent/unscored
        // value to null (never 0), so a run that didn't select Agentic Browsing
        // persists as unscored rather than as a zero score.
        scoreAgenticBrowsing: toScoreInt(scores["agentic-browsing"]),
        // Redacted at the boundary (ROADMAP Phase B): the engine echoes back the
        // options it ran with, so an authenticated run's header/cookie values
        // would land in this column. Names survive as provenance; the queue
        // already redacts, and `redactAuditOptions` is idempotent.
        options: JSON.stringify(redactAuditOptions(result.options)),
        metrics: JSON.stringify(result.median.metrics),
        field: result.field ? JSON.stringify(result.field) : null,
        benchmarkIndex: result.environment.benchmarkIndex,
        hostUserAgent: result.environment.hostUserAgent || null,
        throttlingMethod: result.environment.throttlingMethod || null,
        cpuSlowdownMultiplier: result.environment.cpuSlowdownMultiplier,
        reportJson: reportJsonFilename(job.id),
        reportHtml: htmlFilename,
        fetchTime: result.fetchTime ?? null,
        createdAt: nowIso(),
      })
      .onConflictDoNothing()
      .run();
  } catch (err) {
    warn("recordRun", err);
  }
}

/** Index a failed run (no scores, no report files). Never throws. */
export function recordFailedRun(batch: Batch, job: AuditJob): void {
  try {
    getDb()
      .insert(runs)
      .values({
        id: job.id,
        batchId: batch.id,
        idx: job.index,
        url: job.url,
        finalUrl: null,
        status: "error",
        source: batch.source,
        errorMessage: job.error?.message ?? "Unknown error",
        // The per-job device (PRD §6 Phase 12): for a `"both"` batch each URL
        // fanned out into a mobile + a desktop job, so a failed job must record
        // ITS form factor, not the batch's representative `options.formFactor`.
        // Throttling stays batch-wide (not a per-device override).
        formFactor: job.device,
        throttling: batch.options.throttling,
        runs: null,
        lighthouseVersion: null,
        scorePerformance: null,
        scoreAccessibility: null,
        scoreBestPractices: null,
        scoreSeo: null,
        scoreAgenticBrowsing: null,
        // Redacted like the success path — a failed run records which
        // credential it tried, never the value (ROADMAP Phase B).
        options: JSON.stringify(redactAuditOptions(batch.options)),
        metrics: null,
        field: null,
        benchmarkIndex: null,
        hostUserAgent: null,
        throttlingMethod: null,
        cpuSlowdownMultiplier: null,
        reportJson: null,
        reportHtml: null,
        fetchTime: null,
        createdAt: nowIso(),
      })
      .onConflictDoNothing()
      .run();
  } catch (err) {
    warn("recordFailedRun", err);
  }
}

// --- Deletion --------------------------------------------------------------

/** Remove a run's stored report files (best-effort; never throws). */
async function removeReportFiles(runId: string): Promise<void> {
  try {
    await Promise.all([
      fs.rm(reportJsonPath(runId), { force: true }),
      fs.rm(reportHtmlPath(runId), { force: true }),
    ]);
  } catch (err) {
    warn("removeReportFiles", err);
  }
}

/**
 * Drop any in-memory {@link AuditResult} the queue is still holding for deleted
 * runs, so the DB really is authoritative for whether a run exists.
 *
 * Deleting a run removes its row and its report files, but the queue retains the
 * heavy LHR of every run it has finished — that retention is what lets the report
 * routes serve a run that has not been persisted yet. Without this, a deleted (or
 * "Clear history"-ed) run keeps answering `GET /api/reports/:runId/trace` and
 * `…/diff` for the life of the process, with its audited URL, every subresource
 * URL it fetched and its filmstrip screenshots. Someone clearing history to
 * remove the record of what they audited did not get that — the same shape as
 * ROADMAP Phase C's M2, found again by Phase E's security review.
 *
 * Imported LAZILY because `AuditQueue` imports this module: a static import would
 * be a genuine cycle. `forgetQueuedResults` never constructs a queue, so a
 * process that has not run an audit pays nothing here.
 */
async function forgetInMemoryResults(runId?: string): Promise<void> {
  try {
    const { forgetQueuedResults } = await import("@/lib/queue/AuditQueue");
    forgetQueuedResults(runId);
  } catch (err) {
    // Log-and-swallow like the rest of this module: failing to prune a cache
    // must never turn a successful deletion into a thrown error.
    warn("forgetInMemoryResults", err);
  }
}

/**
 * Delete a single persisted run: its row, its stored report files, and — if it
 * was the batch's last remaining run — the now-orphaned `batches` row too (child
 * runs are deleted first to respect the FK). Returns whether a row was removed.
 * Never throws.
 */
export async function deleteRun(runId: string): Promise<boolean> {
  try {
    const db = getDb();
    const row = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!row) return false;

    // Remove child AI analyses first — `analyses.run_id → runs.id` FK is enforced.
    deleteAnalysesForRun(runId);
    db.delete(runs).where(eq(runs.id, runId)).run();
    await removeReportFiles(runId);
    await forgetInMemoryResults(runId);

    // Orphan cleanup: drop the parent batch once it has no runs left.
    const remaining = db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.batchId, row.batchId))
      .limit(1)
      .all();
    if (remaining.length === 0) {
      db.delete(batches).where(eq(batches.id, row.batchId)).run();
    }
    return true;
  } catch (err) {
    warn("deleteRun", err);
    return false;
  }
}

/**
 * Delete a whole persisted batch: its child AI analyses, every `runs` row, those
 * runs' stored report files, and finally the `batches` row. A console (the History
 * view) shows a batch as a unit, so the destructive "Clear" acts batch-wide rather
 * than per-run. Children are removed before parents to respect the FKs
 * (`analyses.run_id → runs.id`, `runs.batchId → batches.id`), mirroring
 * {@link deleteRun}'s order and reusing {@link removeReportFiles}. Returns whether
 * the batch existed. Never throws.
 */
export async function deleteBatch(batchId: string): Promise<boolean> {
  try {
    const db = getDb();
    const batch = db.select().from(batches).where(eq(batches.id, batchId)).get();
    if (!batch) return false;

    const runIds = db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.batchId, batchId))
      .all()
      .map((r) => r.id);

    // Children before parents: analyses → runs (+ their report files) → batch.
    for (const runId of runIds) deleteAnalysesForRun(runId);
    db.delete(runs).where(eq(runs.batchId, batchId)).run();
    await Promise.all(runIds.map((id) => removeReportFiles(id)));
    db.delete(batches).where(eq(batches.id, batchId)).run();
    return true;
  } catch (err) {
    warn("deleteBatch", err);
    return false;
  }
}

/**
 * Delete ALL persisted history: every `runs` and `batches` row, every regression
 * alert, plus the entire reports directory. Runs are deleted before batches to
 * respect the `runs.batchId → batches.id` FK.
 *
 * The `schedules` table itself is left untouched — it is config, not history —
 * but its `schedule_alerts` children ARE history and go: an alert row records an
 * audited URL and the two scores either side of a regression, and it keeps
 * rendering in the Archive strip. Someone clearing history to remove the record
 * of what they audited must not be left with that record intact in a second
 * table (ROADMAP Phase C security review, M2).
 *
 * Each schedule's `alerts_evaluated_batch_id` is cleared with them, because the
 * batch it names no longer exists; leaving it would be a marker pointing at
 * nothing. Its absence is harmless either way — the next fire has no prior
 * completed batch to compare against, so it simply becomes the new baseline.
 *
 * Returns the counts removed. Never throws.
 */
export async function clearHistory(): Promise<{ runs: number; batches: number }> {
  try {
    const db = getDb();
    const runCount = db.select({ id: runs.id }).from(runs).all().length;
    const batchCount = db.select({ id: batches.id }).from(batches).all().length;

    // Children before parents to respect FKs: analyses → runs → batches.
    deleteAllAnalyses();
    db.delete(runs).run();
    db.delete(batches).run();
    // Alerts are history too (see the docblock). They reference `schedules`, not
    // `batches`, so they are not swept by the deletes above and need their own.
    db.delete(scheduleAlerts).run();
    db.update(schedules).set({ alertsEvaluatedBatchId: null }).run();

    // Wipe report files wholesale; the directory is recreated lazily by recordRun.
    try {
      await fs.rm(getReportsDir(), { recursive: true, force: true });
    } catch (err) {
      warn("clearHistory:reports", err);
    }
    await forgetInMemoryResults();

    return { runs: runCount, batches: batchCount };
  } catch (err) {
    warn("clearHistory", err);
    return { runs: 0, batches: 0 };
  }
}

// --- Reads -----------------------------------------------------------------

/** Every persisted run, newest first. Returns `[]` on any error. */
export function listHistory(): HistoryRow[] {
  try {
    const rows = getDb()
      .select()
      .from(runs)
      .orderBy(desc(runs.createdAt))
      .all();
    return rows.map(rowToHistory);
  } catch (err) {
    warn("listHistory", err);
    return [];
  }
}

/** Every persisted batch, newest first. Returns `[]` on any error. */
export function listBatches(): BatchInfo[] {
  try {
    const rows = getDb()
      .select()
      .from(batches)
      .orderBy(desc(batches.createdAt))
      .all();
    return rows.map(rowToBatchInfo);
  } catch (err) {
    warn("listBatches", err);
    return [];
  }
}

/** The inputs the AI analyzer needs for a persisted run, beyond its LHR. */
export interface RunInputs {
  formFactor: FormFactor;
  /** Real-world CrUX field data (PSI runs only), or null. */
  field: FieldData | null;
  source: AuditSource;
}

/**
 * Read the analyzer inputs for a run (its device + CrUX field data) from the
 * `runs` row — the LHR on disk doesn't carry the PSI field data. Returns
 * `undefined` if the run is unknown. Never throws.
 */
export function getRunInputs(runId: string): RunInputs | undefined {
  try {
    const row = getDb().select().from(runs).where(eq(runs.id, runId)).get();
    if (!row) return undefined;
    return {
      formFactor: row.formFactor === "desktop" ? "desktop" : "mobile",
      field: safeParse<FieldData>(row.field, "getRunInputs:field"),
      source: row.source === "psi" ? "psi" : "local",
    };
  } catch (err) {
    warn("getRunInputs", err);
    return undefined;
  }
}

/** A run's stored report file paths, or `undefined` if unknown. */
export function getRunReport(runId: string): RunReport | undefined {
  try {
    const row = getDb().select().from(runs).where(eq(runs.id, runId)).get();
    if (!row) return undefined;
    return {
      id: row.id,
      url: row.url,
      jsonPath: row.reportJson ? reportJsonPath(row.id) : null,
      htmlPath: row.reportHtml ? reportHtmlPath(row.id) : null,
    };
  } catch (err) {
    warn("getRunReport", err);
    return undefined;
  }
}

/**
 * Reassemble a *lite* {@link Batch} from its persisted `batches` row + `runs`
 * rows — the inverse of `recordRun`/`recordFailedRun` — so a completed run's
 * results survive a server restart (PRD §6 Phase 15). The in-memory
 * {@link AuditQueue} is the live source while a batch is in flight; once the
 * process restarts the queue is empty, and the audit routes fall back to this.
 *
 * **Lossy by design.** `perRunScores` / `perRunEnvironments`, the opportunities
 * list, and the Best-Practices audit breakdown are not persisted as columns, so a
 * restored job degrades gracefully *without* the variance / spread / opportunities
 * sub-detail — the median scores, Core Web Vitals, environment, and report links
 * all survive. Only settled runs (`done`/`error`) are ever persisted, so a
 * reconstructed batch never carries `queued`/`running` jobs.
 *
 * **Always terminal.** A batch only reaches here because the live
 * {@link AuditQueue} no longer owns it (the process that was running it is gone),
 * so an in-flight job can never resume. The persisted status is coerced to a
 * terminal one via {@link reconstructedStatus} — a process killed mid-run leaves
 * the row at `queued`/`running`, and surfacing that verbatim would make the audit
 * stream send a perpetually-"running" snapshot it never closes (the client would
 * spin on "Running…" forever). So the stream route always sends one snapshot and
 * closes. Returns `undefined` for an unknown id. Never throws.
 */
export function reconstructBatch(batchId: string): Batch | undefined {
  try {
    const db = getDb();
    const batchRow = db
      .select()
      .from(batches)
      .where(eq(batches.id, batchId))
      .get();
    if (!batchRow) return undefined;

    const runRows = db
      .select()
      .from(runs)
      .where(eq(runs.batchId, batchId))
      .orderBy(runs.idx)
      .all();

    const jobs = runRows.map(rowToJob);
    return {
      id: batchRow.id,
      status: reconstructedStatus(batchRow.status as BatchStatus, jobs),
      device: deriveDevice(runRows, batchRow),
      source: batchRow.source === "psi" ? "psi" : "local",
      options:
        safeParse<AuditOptions>(batchRow.options, "reconstructBatch:options") ??
        FALLBACK_OPTIONS,
      concurrency: batchRow.concurrency,
      priorBatchId: batchRow.priorBatchId ?? undefined,
      scheduleId: batchRow.scheduleId ?? undefined,
      jobs,
      counts: countsFromJobs(jobs),
      createdAt: batchRow.createdAt,
      startedAt: batchRow.startedAt ?? undefined,
      finishedAt: batchRow.finishedAt ?? undefined,
    };
  } catch (err) {
    warn("reconstructBatch", err);
    return undefined;
  }
}

// --- Internals -------------------------------------------------------------

/** Safely JSON-parse a nullable text column, returning `null` on absence/error. */
function safeParse<T>(value: string | null, op: string): T | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    warn(op, err);
    return null;
  }
}

/**
 * Reconstruct a {@link RunEnvironment} from a `runs` row's environment columns.
 * Returns `null` when the row carries no environment data — failed runs, or rows
 * persisted before the Phase 10 migration (so the UI can hide the badge rather
 * than render an empty one).
 */
function rowToEnvironment(row: RunRow): RunEnvironment | null {
  if (row.benchmarkIndex === null && row.throttlingMethod === null) return null;
  return {
    benchmarkIndex: row.benchmarkIndex,
    hostUserAgent: row.hostUserAgent ?? "",
    throttlingMethod: row.throttlingMethod ?? "",
    cpuSlowdownMultiplier: row.cpuSlowdownMultiplier,
  };
}

/** Minimal options fallback when a row's options JSON is missing/unparseable. */
const FALLBACK_OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: [],
  runs: 1,
  warmCache: true,
};

/** Flatten a `runs` row into a {@link HistoryRow}. */
function rowToHistory(row: RunRow): HistoryRow {
  const scores: CategoryScores = {
    performance: row.scorePerformance,
    accessibility: row.scoreAccessibility,
    "best-practices": row.scoreBestPractices,
    seo: row.scoreSeo,
    // Null on legacy rows (written before the 0007 migration) and on runs that
    // didn't select the category — the same "unscored" state the four above use
    // for a failed run. Deliberately not coalesced to 0.
    "agentic-browsing": row.scoreAgenticBrowsing,
  };
  return {
    id: row.id,
    batchId: row.batchId,
    url: row.url,
    finalUrl: row.finalUrl,
    status: row.status === "error" ? "error" : "done",
    errorMessage: row.errorMessage,
    formFactor: row.formFactor === "desktop" ? "desktop" : "mobile",
    source: row.source === "psi" ? "psi" : "local",
    runs: row.runs,
    options:
      safeParse<AuditOptions>(row.options, "rowToHistory:options") ??
      FALLBACK_OPTIONS,
    scores,
    metrics: safeParse<CoreWebVitals>(row.metrics, "rowToHistory:metrics"),
    field: safeParse<FieldData>(row.field, "rowToHistory:field"),
    environment: rowToEnvironment(row),
    hasJsonReport: row.reportJson !== null,
    hasHtmlReport: row.reportHtml !== null,
    fetchTime: row.fetchTime,
    createdAt: row.createdAt,
  };
}

/** Flatten a `batches` row into a {@link BatchInfo}. */
function rowToBatchInfo(row: BatchRow): BatchInfo {
  return {
    id: row.id,
    status: row.status as BatchStatus,
    source: row.source === "psi" ? "psi" : "local",
    options:
      safeParse<AuditOptions>(row.options, "rowToBatchInfo:options") ??
      FALLBACK_OPTIONS,
    concurrency: row.concurrency,
    total: row.total,
    priorBatchId: row.priorBatchId ?? null,
    scheduleId: row.scheduleId ?? null,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** All Core Web Vitals null — the median-metrics fallback for an unparseable row. */
const EMPTY_METRICS: CoreWebVitals = {
  "largest-contentful-paint": null,
  "cumulative-layout-shift": null,
  "total-blocking-time": null,
  "first-contentful-paint": null,
  "speed-index": null,
  interactive: null,
};

/** Neutral environment for a row with no persisted environment columns. */
const EMPTY_ENVIRONMENT: RunEnvironment = {
  benchmarkIndex: null,
  hostUserAgent: "",
  throttlingMethod: "",
  cpuSlowdownMultiplier: null,
};

/** Batch lifecycle states from which no further progress will ever be emitted. */
const TERMINAL_BATCH_STATUSES = new Set<BatchStatus>([
  "completed",
  "completed_with_errors",
  "cancelled",
]);

/**
 * Resolve the terminal status a reconstructed batch should carry. A batch only
 * reaches {@link reconstructBatch} once the live queue no longer owns it, so an
 * already-terminal status is returned as-is (the Phase 15 happy path). A
 * still-non-terminal status means the process died mid-run before the batch
 * finalized; it must be coerced terminal (or the stream never closes). The
 * coerced state is derived from the persisted (settled) runs, mirroring the
 * queue's `maybeFinalizeBatch`: any error → `completed_with_errors`, all done →
 * `completed`, and none persisted → `cancelled` (interrupted with nothing to
 * show — keeps the result panel honest rather than claiming "completed 0/0").
 */
function reconstructedStatus(
  persisted: BatchStatus,
  jobs: AuditJob[],
): BatchStatus {
  if (TERMINAL_BATCH_STATUSES.has(persisted)) return persisted;
  if (jobs.length === 0) return "cancelled";
  return jobs.some((j) => j.status === "error")
    ? "completed_with_errors"
    : "completed";
}

/** Aggregate {@link BatchCounts} from a job list (mirrors the queue's `computeCounts`). */
function countsFromJobs(jobs: AuditJob[]): BatchCounts {
  const counts: BatchCounts = {
    total: jobs.length,
    queued: 0,
    running: 0,
    done: 0,
    error: 0,
    cancelled: 0,
  };
  for (const job of jobs) counts[job.status] += 1;
  return counts;
}

/**
 * Derive a batch's {@link DeviceSelection} from its persisted runs: `"both"` when
 * a URL was audited on mobile *and* desktop, else the single device present. Falls
 * back to the batch options' representative form factor when no runs persisted.
 */
function deriveDevice(runRows: RunRow[], batchRow: BatchRow): DeviceSelection {
  const hasMobile = runRows.some((r) => r.formFactor === "mobile");
  const hasDesktop = runRows.some((r) => r.formFactor === "desktop");
  if (hasMobile && hasDesktop) return "both";
  if (hasDesktop) return "desktop";
  if (hasMobile) return "mobile";
  const opts = safeParse<AuditOptions>(
    batchRow.options,
    "reconstructBatch:deviceOptions",
  );
  return opts?.formFactor ?? "mobile";
}

/**
 * Reconstruct the lhr-stripped {@link AuditResultLite} for a successful run from
 * its row. The heavy/uncolumned fields (opportunities, best-practices breakdown,
 * per-run spread) are intentionally empty — see {@link reconstructBatch}.
 */
function rowToResultLite(row: RunRow, device: FormFactor): AuditResultLite {
  const scores: CategoryScores = {
    performance: row.scorePerformance,
    accessibility: row.scoreAccessibility,
    "best-practices": row.scoreBestPractices,
    seo: row.scoreSeo,
    "agentic-browsing": row.scoreAgenticBrowsing,
  };
  return {
    requestedUrl: row.url,
    finalUrl: row.finalUrl ?? row.url,
    options:
      safeParse<AuditOptions>(row.options, "reconstructBatch:runOptions") ?? {
        ...FALLBACK_OPTIONS,
        formFactor: device,
      },
    runs: row.runs ?? 1,
    median: {
      scores,
      metrics:
        safeParse<CoreWebVitals>(row.metrics, "reconstructBatch:metrics") ??
        EMPTY_METRICS,
      opportunities: [],
      bestPractices: [],
    },
    // Not persisted as columns — a restored run degrades without the spread detail.
    perRunScores: [],
    perRunEnvironments: [],
    fetchTime: row.fetchTime ?? row.createdAt,
    lighthouseVersion: row.lighthouseVersion ?? "",
    runWarnings: [],
    environment: rowToEnvironment(row) ?? EMPTY_ENVIRONMENT,
    source: row.source === "psi" ? "psi" : "local",
    field: safeParse<FieldData>(row.field, "reconstructBatch:field") ?? undefined,
  };
}

/**
 * Flatten a settled `runs` row into an {@link AuditJob} (only `done`/`error` rows
 * are ever persisted). `queuedAt`/`finishedAt` aren't stored, so they fall back to
 * the row's `createdAt`/`fetchTime` for a stable, non-empty lifecycle marker.
 */
function rowToJob(row: RunRow): AuditJob {
  const device: FormFactor = row.formFactor === "desktop" ? "desktop" : "mobile";
  const base: AuditJob = {
    id: row.id,
    index: row.idx,
    url: row.url,
    device,
    status: row.status === "error" ? "error" : "done",
    queuedAt: row.createdAt,
    finishedAt: row.fetchTime ?? row.createdAt,
  };
  if (row.status === "error") {
    return { ...base, error: { message: row.errorMessage ?? "Unknown error" } };
  }
  return { ...base, result: rowToResultLite(row, device) };
}

/**
 * Render a standalone Lighthouse HTML report from a raw LHR. Dynamic import so
 * Lighthouse's report generator stays out of the module graph until needed
 * (`lighthouse` is in `serverExternalPackages`, so never bundled). Mirrors the
 * generation that `GET /api/reports/:runId?format=html` previously did inline.
 */
async function generateHtmlReport(lhr: unknown): Promise<string> {
  const { ReportGenerator } = await import(
    "lighthouse/report/generator/report-generator.js"
  );
  return ReportGenerator.generateReport(
    lhr as Parameters<typeof ReportGenerator.generateReport>[0],
    "html",
  ) as string;
}

// Re-export for consumers that want to assemble metrics from a raw row later.
export type { CoreWebVitals };
