"use client";

/**
 * `useRunTrace` — read a completed run's waterfall + filmstrip ON DEMAND.
 *
 * The lazy half of ROADMAP Phase D's "report JSON is read on demand when the tab
 * opens": nothing is fetched until the caller passes `active: true`, so
 * `/history` and the detail sheet's other tabs never pay for a stored report.
 *
 * **Why it caches.** A `RunTrace` is a projection of an immutable artefact — the
 * stored LHR of a run that has already finished — so it can never go stale. The
 * hook therefore fetches AT MOST ONCE per run id: closing and reopening the tab,
 * or any re-render, replays the cached value rather than re-reading a ~690 KB
 * report on the server. Only an explicit `retry()` after a failure refetches.
 *
 * Shape follows `useAnalysisStream`: typed state folded in one place, a
 * reset-during-render when the target changes (React's recommended alternative
 * to a reset-in-effect), and no auto-reconnect — a failure is terminal until the
 * user asks again. `status` is DERIVED from the loaded/failed/requested triple
 * rather than stored, so there is no state to drift out of sync with the fetch.
 */

import { useCallback, useEffect, useState } from "react";

import { ApiError } from "@/lib/client/auditClient";
import { getRunTrace } from "@/lib/client/reportTrace";
import type { RunTrace } from "@/lib/reports/types";

/** Hook status: idle (nothing requested yet) → loading → loaded | error. */
export type RunTraceStatus = "idle" | "loading" | "loaded" | "error";

export interface UseRunTraceResult {
  status: RunTraceStatus;
  /** The projection, once loaded. Null until then, and after a failure. */
  trace: RunTrace | null;
  /** Terminal error, if any. */
  error: { code: string; message: string } | null;
  /** True while the single read for this run is in flight. */
  isLoading: boolean;
  /** Re-read after a failure. */
  retry: () => void;
}

/** Normalise a thrown value into the hook's `{ code, message }` error shape. */
function toErrorState(err: unknown): { code: string; message: string } {
  if (err instanceof ApiError) return { code: err.code, message: err.message };
  return {
    code: "network_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * @param runId  The run whose trace to read.
 * @param active Whether the consumer (the Trace tab) is open. Nothing is fetched
 *   while this is false; once it has been true the read is latched, so a tab the
 *   user closes mid-flight still completes rather than being cancelled and
 *   restarted on reopen.
 */
export function useRunTrace(runId: string, active: boolean): UseRunTraceResult {
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  // Latches once the caller first says the tab is open (see `active` above).
  const [requested, setRequested] = useState(active);
  // Bumped by `retry()` only — the effect's re-run trigger, and the reason a
  // settled load never refetches (nothing else changes it).
  const [attempt, setAttempt] = useState(0);

  // Reset synchronously during render when the run changes — the device flip in
  // the detail sheet swaps run ids under a mounted tab, and the previous run's
  // trace must not be shown for the new one. The in-flight response for the old
  // id is discarded by the effect's cleanup, which runs on the same change.
  const [trackedRunId, setTrackedRunId] = useState(runId);
  if (runId !== trackedRunId) {
    setTrackedRunId(runId);
    setTrace(null);
    setError(null);
    setAttempt(0);
    setRequested(active);
  } else if (active && !requested) {
    setRequested(true);
  }

  useEffect(() => {
    if (!requested) return;

    const controller = new AbortController();
    // Guards against setting state after unmount, or after the run id changed:
    // both tear this effect down, and the late response is dropped.
    let ignore = false;

    void (async () => {
      try {
        const next = await getRunTrace(runId, controller.signal);
        if (ignore) return;
        setTrace(next);
      } catch (err) {
        if (ignore) return;
        setError(toErrorState(err));
      }
    })();

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [requested, runId, attempt]);

  const retry = useCallback(() => {
    // Clearing the failure here rather than in the effect keeps the effect body
    // free of synchronous setState — the status below goes back to "loading" on
    // this same render, and the bumped attempt re-runs the read.
    setError(null);
    setTrace(null);
    setRequested(true);
    setAttempt((n) => n + 1);
  }, []);

  const status: RunTraceStatus = !requested
    ? "idle"
    : error
      ? "error"
      : trace
        ? "loaded"
        : "loading";

  return {
    status,
    trace,
    error,
    isLoading: status === "loading",
    retry,
  };
}
