/**
 * Median-run selection shared by both engines — the local `median.ts` and the
 * PageSpeed Insights engine (`runPsiAudit.ts`).
 *
 * Pulled out of `median.ts` so the IN-PROCESS PSI path can reuse it WITHOUT
 * importing `median.ts` (which transitively loads `runAudit.ts` →
 * `lighthouse`/`chrome-launcher` — forbidden in the server in-process path). Its
 * only dependency, `computeMedianRun`, is a pure arithmetic helper from the
 * `lighthouse` package: it reads `lhr.audits[…].numericValue` and sorts; no
 * Chrome, no imports, no side effects.
 */

import { computeMedianRun } from "lighthouse/core/lib/median-run.js";

import type { LighthouseResult } from "@/lib/lighthouse/types";

/**
 * Pick the median run from a non-empty list of completed runs, keyed on each
 * run's raw LHR.
 *
 * Prefers Lighthouse's `computeMedianRun` (which selects the run whose key
 * metrics are median). Falls back to the middle run by index if there is only one
 * run, or if `computeMedianRun` throws (e.g. an LHR with no `interactive`/TTI
 * audit, as in Lighthouse 13) or returns an unrecognised LHR.
 *
 * Generic over any run object that carries an `lhr`, so both the local
 * `SingleRunResult` and the PSI engine's per-run shape reuse it without adapters.
 */
export function selectMedianRun<T extends { lhr: LighthouseResult }>(
  runs: T[],
): T {
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
