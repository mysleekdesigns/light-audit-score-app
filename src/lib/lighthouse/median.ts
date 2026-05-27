/**
 * Median-of-N orchestration (PRD §6 Phase 1).
 *
 * Runs `runSingleAudit` SEQUENTIALLY `options.runs` times — parallel runs
 * distort performance scores — then selects the median run via Lighthouse's
 * `computeMedianRun`. Per-run category scores are surfaced for variance display.
 */

import { computeMedianRun } from "lighthouse/core/lib/median-run.js";

import { parseLhr, runSingleAudit } from "@/lib/lighthouse/runAudit";
import {
  type AuditResult,
  type CategoryScores,
  type LighthouseResult,
  type RunAudit,
  type SingleRunResult,
} from "@/lib/lighthouse/types";

/**
 * Pick the median run from a non-empty list of completed runs.
 *
 * Prefers Lighthouse's `computeMedianRun` (which selects the run whose key
 * metrics are median). Falls back to the middle run by index if there is only
 * one run, or if `computeMedianRun` throws or returns an unrecognised LHR.
 */
function selectMedianRun(runs: SingleRunResult[]): SingleRunResult {
  const middle = runs[Math.floor((runs.length - 1) / 2)];
  if (runs.length === 1) return runs[0];

  let medianLhr: LighthouseResult | undefined;
  try {
    medianLhr = computeMedianRun(
      runs.map((run) => run.lhr),
    ) as LighthouseResult;
  } catch {
    return middle;
  }
  if (!medianLhr) return middle;

  // Match the returned LHR back to one of our runs by reference, then by
  // fetchTime, so we keep the already-parsed result alongside its raw LHR.
  const byReference = runs.find((run) => run.lhr === medianLhr);
  if (byReference) return byReference;

  const medianFetchTime =
    typeof medianLhr.fetchTime === "string" ? medianLhr.fetchTime : undefined;
  if (medianFetchTime) {
    const byFetchTime = runs.find(
      (run) => run.lhr.fetchTime === medianFetchTime,
    );
    if (byFetchTime) return byFetchTime;
  }

  return middle;
}

/**
 * Run Lighthouse `options.runs` times against `url` and return the median run
 * plus per-run scores. Options must be pre-validated by `options.ts`.
 */
export const runAudit: RunAudit = async (url, options) => {
  const runs: SingleRunResult[] = [];
  // Sequential by design — concurrent runs contend for CPU and distort timings.
  // No partial-success: if any run throws (unreachable URL, Chrome launch
  // failure, timeout, …) we let it propagate and fail the whole job. The error
  // is already a friendly, classified one-liner (runSingleAudit funnels every
  // throw through `classifyAuditError`), so it's safe to surface verbatim.
  for (let i = 0; i < options.runs; i += 1) {
    runs.push(await runSingleAudit(url, options));
  }

  const perRunScores: CategoryScores[] = runs.map((run) => run.scores);
  const median = selectMedianRun(runs);

  // Re-parse the median LHR so median.{scores,metrics,opportunities} are
  // derived from exactly the LHR we surface as `median.lhr`.
  const parsedMedian = parseLhr(median.lhr, options.formFactor);

  const runWarnings = Array.from(
    new Set(runs.flatMap((run) => run.runWarnings)),
  );

  const result: AuditResult = {
    requestedUrl: parsedMedian.requestedUrl || url,
    finalUrl: parsedMedian.finalUrl,
    options,
    runs: runs.length,
    median: {
      scores: parsedMedian.scores,
      metrics: parsedMedian.metrics,
      opportunities: parsedMedian.opportunities,
      lhr: median.lhr,
    },
    perRunScores,
    fetchTime: parsedMedian.fetchTime,
    lighthouseVersion: parsedMedian.lighthouseVersion,
    runWarnings,
  };

  return result;
};
