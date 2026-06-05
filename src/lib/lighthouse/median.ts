/**
 * Median-of-N orchestration (PRD §6 Phase 1).
 *
 * Runs `runSingleAudit` SEQUENTIALLY `options.runs` times — parallel runs
 * distort performance scores — then selects the median run via Lighthouse's
 * `computeMedianRun`. Per-run category scores are surfaced for variance display.
 */

import {
  createAuditSession,
  parseLhr,
  runSingleAudit,
} from "@/lib/lighthouse/runAudit";
import { selectMedianRun } from "@/lib/lighthouse/select-median-run";
import {
  type AuditResult,
  type CategoryScores,
  type RunAudit,
  type RunEnvironment,
  type SingleRunResult,
} from "@/lib/lighthouse/types";

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
  if (options.warmCache === true) {
    // Warm-cache mode (DevTools-panel parity): reuse ONE Chrome profile across
    // all runs. A first navigation is always a cold miss, so we throw away an
    // explicit warm-up run, then take the `options.runs` measured runs against
    // the now-warm cache. This makes even a single-run audit reproducible at
    // the warm/repeat-visit number instead of a cold-load roll of the dice.
    // See AuditOptions.warmCache.
    const session = await createAuditSession();
    try {
      await runSingleAudit(url, options, session); // warm-up; result discarded
      for (let i = 0; i < options.runs; i += 1) {
        runs.push(await runSingleAudit(url, options, session));
      }
    } finally {
      await session.dispose();
    }
  } else {
    // Cold first-visit mode: each run gets its own fresh, self-disposed profile.
    for (let i = 0; i < options.runs; i += 1) {
      runs.push(await runSingleAudit(url, options));
    }
  }

  const perRunScores: CategoryScores[] = runs.map((run) => run.scores);
  const perRunEnvironments: RunEnvironment[] = runs.map(
    (run) => run.environment,
  );
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
      bestPractices: parsedMedian.bestPractices,
      lhr: median.lhr,
    },
    perRunScores,
    perRunEnvironments,
    fetchTime: parsedMedian.fetchTime,
    lighthouseVersion: parsedMedian.lighthouseVersion,
    runWarnings,
    environment: parsedMedian.environment,
  };

  return result;
};
