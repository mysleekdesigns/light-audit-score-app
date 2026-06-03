/**
 * Persistence for AI score analyses (the "explain & fix my score" feature).
 *
 * One row per `(runId, category)`; re-running overwrites via the unique index.
 * Mirrors the log-and-swallow discipline of `persistence.ts` / `schedules.ts`:
 * analysis is a cache of an expensive agent run, so a DB hiccup must never crash
 * the route — writes are best-effort and reads degrade to `null`/`[]`.
 */

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { getDb } from "@/lib/db/client";
import { analyses, type AnalysisRow } from "@/lib/db/schema";
import type {
  AnalysisCategory,
  AnalysisCitation,
  AnalysisResult,
  Fix,
} from "@/lib/analysis/types";

/** Log + swallow a persistence failure (never propagate to the caller). */
function warn(op: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[analyses] ${op} failed: ${message}`);
}

/** Safely JSON-parse a column, returning `fallback` on absence/error. */
function safeParse<T>(value: string | null, fallback: T, op: string): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    warn(op, err);
    return fallback;
  }
}

/** Flatten an `analyses` row into an {@link AnalysisResult}. */
function rowToAnalysis(row: AnalysisRow): AnalysisResult {
  const warnings = row.warnings
    ? safeParse<string[]>(row.warnings, [], "rowToAnalysis:warnings")
    : undefined;
  return {
    runId: row.runId,
    category: row.category as AnalysisCategory,
    categoryScore: row.categoryScore,
    diagnosis: row.diagnosis,
    fixes: safeParse<Fix[]>(row.fixes, [], "rowToAnalysis:fixes"),
    sources: safeParse<AnalysisCitation[]>(row.sources, [], "rowToAnalysis:sources"),
    model: row.model,
    createdAt: row.createdAt,
    costUsd: row.costUsd ?? undefined,
    turns: row.turns ?? undefined,
    warnings: warnings && warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Upsert an analysis, keyed by `(runId, category)`. A re-analyze overwrites the
 * existing row's content (its id is preserved). Best-effort; never throws.
 */
export function saveAnalysis(result: AnalysisResult): void {
  try {
    const values = {
      id: nanoid(),
      runId: result.runId,
      category: result.category,
      categoryScore: result.categoryScore,
      model: result.model,
      diagnosis: result.diagnosis,
      fixes: JSON.stringify(result.fixes),
      sources: JSON.stringify(result.sources),
      costUsd: result.costUsd ?? null,
      turns: result.turns ?? null,
      warnings: result.warnings ? JSON.stringify(result.warnings) : null,
      createdAt: result.createdAt,
    };
    getDb()
      .insert(analyses)
      .values(values)
      .onConflictDoUpdate({
        target: [analyses.runId, analyses.category],
        set: {
          categoryScore: values.categoryScore,
          model: values.model,
          diagnosis: values.diagnosis,
          fixes: values.fixes,
          sources: values.sources,
          costUsd: values.costUsd,
          turns: values.turns,
          warnings: values.warnings,
          createdAt: values.createdAt,
        },
      })
      .run();
  } catch (err) {
    warn("saveAnalysis", err);
  }
}

/** The persisted analysis for a `(runId, category)`, or `null` if none/error. */
export function getAnalysis(
  runId: string,
  category: AnalysisCategory,
): AnalysisResult | null {
  try {
    const row = getDb()
      .select()
      .from(analyses)
      .where(and(eq(analyses.runId, runId), eq(analyses.category, category)))
      .get();
    return row ? rowToAnalysis(row) : null;
  } catch (err) {
    warn("getAnalysis", err);
    return null;
  }
}

/** All persisted analyses for a run (any category). Returns `[]` on error. */
export function listAnalyses(runId: string): AnalysisResult[] {
  try {
    const rows = getDb()
      .select()
      .from(analyses)
      .where(eq(analyses.runId, runId))
      .all();
    return rows.map(rowToAnalysis);
  } catch (err) {
    warn("listAnalyses", err);
    return [];
  }
}

/** Delete every analysis for a run (called before deleting the run — FK is ON). */
export function deleteAnalysesForRun(runId: string): void {
  try {
    getDb().delete(analyses).where(eq(analyses.runId, runId)).run();
  } catch (err) {
    warn("deleteAnalysesForRun", err);
  }
}

/** Delete ALL analyses (called before clearing all history — FK is ON). */
export function deleteAllAnalyses(): void {
  try {
    getDb().delete(analyses).run();
  } catch (err) {
    warn("deleteAllAnalyses", err);
  }
}
