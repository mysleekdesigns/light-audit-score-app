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
 */

import { promises as fs } from "node:fs";

import { desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  getReportsDir,
  reportHtmlFilename,
  reportHtmlPath,
  reportJsonFilename,
  reportJsonPath,
} from "@/lib/db/paths";
import { batches, runs, type BatchRow, type RunRow } from "@/lib/db/schema";
import type {
  AuditOptions,
  AuditResult,
  CategoryScores,
  CoreWebVitals,
  FormFactor,
  RunEnvironment,
} from "@/lib/lighthouse/types";
import type { AuditJob, Batch, BatchStatus } from "@/lib/queue/types";

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
        options: JSON.stringify(batch.options),
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
        errorMessage: null,
        formFactor: result.options.formFactor,
        throttling: result.options.throttling,
        runs: result.runs,
        lighthouseVersion: result.lighthouseVersion,
        scorePerformance: toScoreInt(scores.performance),
        scoreAccessibility: toScoreInt(scores.accessibility),
        scoreBestPractices: toScoreInt(scores["best-practices"]),
        scoreSeo: toScoreInt(scores.seo),
        options: JSON.stringify(result.options),
        metrics: JSON.stringify(result.median.metrics),
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
        options: JSON.stringify(batch.options),
        metrics: null,
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

    db.delete(runs).where(eq(runs.id, runId)).run();
    await removeReportFiles(runId);

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
 * Delete ALL persisted history: every `runs` and `batches` row plus the entire
 * reports directory. Runs are deleted before batches to respect the
 * `runs.batchId → batches.id` FK. The `schedules` table is left untouched (it's
 * config, not history). Returns the counts removed. Never throws.
 */
export async function clearHistory(): Promise<{ runs: number; batches: number }> {
  try {
    const db = getDb();
    const runCount = db.select({ id: runs.id }).from(runs).all().length;
    const batchCount = db.select({ id: batches.id }).from(batches).all().length;

    db.delete(runs).run();
    db.delete(batches).run();

    // Wipe report files wholesale; the directory is recreated lazily by recordRun.
    try {
      await fs.rm(getReportsDir(), { recursive: true, force: true });
    } catch (err) {
      warn("clearHistory:reports", err);
    }

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
  };
  return {
    id: row.id,
    batchId: row.batchId,
    url: row.url,
    finalUrl: row.finalUrl,
    status: row.status === "error" ? "error" : "done",
    errorMessage: row.errorMessage,
    formFactor: row.formFactor === "desktop" ? "desktop" : "mobile",
    runs: row.runs,
    options:
      safeParse<AuditOptions>(row.options, "rowToHistory:options") ??
      FALLBACK_OPTIONS,
    scores,
    metrics: safeParse<CoreWebVitals>(row.metrics, "rowToHistory:metrics"),
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
