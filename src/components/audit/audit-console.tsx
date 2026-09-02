"use client";

/**
 * Client orchestrator for the New Audit flow (PRD §6 Phase 3).
 *
 * The audit session itself — the watched batch, its live SSE stream, the
 * submit / cancel / archive / clear actions and the completion toast — lives in
 * {@link AuditSessionProvider} at the root layout, so it survives navigating
 * away from `/` and back (and a reload, via its persisted batch pointer). This
 * component is the page-level view over that session:
 *  - renders {@link NewAuditForm}, wiring its submit to the session;
 *  - renders {@link AuditResults} (the live per-URL grid) off the session's batch;
 *  - opens {@link AuditDetailSheet} for a selected job (the one piece of state
 *    that is genuinely page-local).
 *
 * `initialBatchId` (PRD §6 Phase 13) lets a Re-run elsewhere (Batch summary /
 * History) deep-link here via `/?watch=<batchId>` to watch the re-run stream
 * live — it hands the id to the session, which persists it like any other run.
 */

import { useEffect, useMemo, useState } from "react";

import { AuditDetailSheet } from "@/components/audit/audit-detail-sheet";
import { AuditResults } from "@/components/audit/audit-results";
import { useAuditSession } from "@/components/audit/audit-session-provider";
import { NewAuditForm } from "@/components/audit/new-audit-form";
import type { AuditJob } from "@/lib/queue/types";

export function AuditConsole({
  initialBatchId,
}: {
  /** Seed a batch to watch live (e.g. a Re-run deep-linked via `/?watch=<id>`). */
  initialBatchId?: string;
} = {}) {
  const { state, actions } = useAuditSession("local");
  const { batch, batchId, connection, running, cancelling } = state;
  const { watch } = actions;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Deep link: hand the batch to the session. `watch` is stable, so this runs
  // once per distinct id — never again on unrelated session changes.
  useEffect(() => {
    if (initialBatchId) watch(initialBatchId);
  }, [initialBatchId, watch]);

  // A new run (or a dismissal) invalidates the detail-sheet selection. Reset it
  // during render, keyed on the batch id — React's adjust-state-on-change pattern.
  const [trackedBatchId, setTrackedBatchId] = useState(batchId);
  if (batchId !== trackedBatchId) {
    setTrackedBatchId(batchId);
    setSelectedId(null);
    setSheetOpen(false);
  }

  // Latest completed run's host benchmark, for the form's Calibrate affordance
  // (PRD §6 Phase 9 — reuse a real run's `benchmarkIndex`, no server benchmark).
  // Newest finished job wins: scan done jobs and keep the one with the latest
  // `finishedAt` that actually reported a benchmark.
  const latestBenchmarkIndex = useMemo<number | null>(() => {
    if (!batch) return null;
    let best: { at: number; index: number } | null = null;
    for (const job of batch.jobs) {
      const index = job.result?.environment?.benchmarkIndex;
      if (job.status !== "done" || typeof index !== "number") continue;
      const at = job.finishedAt ? Date.parse(job.finishedAt) : 0;
      if (!best || at >= best.at) best = { at, index };
    }
    return best?.index ?? null;
  }, [batch]);

  const selectedJob: AuditJob | null =
    (selectedId && batch?.jobs.find((j) => j.id === selectedId)) || null;

  // The selected job's device pair: every job in the batch sharing its URL (1 for
  // a single-device batch, up to 2 — mobile + desktop — for a "both" batch). The
  // sheet uses this to offer a device flip; `selectedJob` is the one clicked.
  const selectedPair = useMemo<AuditJob[]>(() => {
    if (!selectedJob || !batch) return [];
    return batch.jobs.filter((j) => j.url === selectedJob.url);
  }, [selectedJob, batch]);

  function handleSelect(job: AuditJob) {
    setSelectedId(job.id);
    setSheetOpen(true);
  }

  return (
    <div className="flex flex-col gap-8">
      <NewAuditForm
        onSubmit={actions.submit}
        isRunning={running}
        latestBenchmarkIndex={latestBenchmarkIndex}
        hasBatch={batch != null}
        results={
          batch ? (
            <AuditResults
              batch={batch}
              connection={connection}
              onSelect={handleSelect}
              onCancel={actions.cancel}
              cancelling={cancelling}
              onArchive={actions.archive}
              onClear={actions.clear}
            />
          ) : null
        }
      />

      <AuditDetailSheet
        job={selectedJob}
        jobs={selectedPair}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
    </div>
  );
}
