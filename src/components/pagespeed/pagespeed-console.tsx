"use client";

/**
 * Client orchestrator for the PageSpeed Insights flow (PSI feature) — the lean
 * sibling of {@link AuditConsole}. The session (watched batch, live stream,
 * actions, completion toast) lives in {@link AuditSessionProvider} under the
 * `"psi"` engine, so a run keeps streaming while the user visits other pages and
 * is exactly where they left it on return. This component renders
 * {@link PsiAuditForm}, the shared {@link AuditResults} grid and
 * {@link AuditDetailSheet} over that session; only the detail-sheet selection is
 * page-local. `?watch=<batchId>` deep-links a re-run here to stream live.
 */

import { useEffect, useMemo, useState } from "react";

import { AuditDetailSheet } from "@/components/audit/audit-detail-sheet";
import { AuditResults } from "@/components/audit/audit-results";
import { useAuditSession } from "@/components/audit/audit-session-provider";
import { PsiAuditForm } from "@/components/pagespeed/psi-audit-form";
import type { AuditJob } from "@/lib/queue/types";

export function PageSpeedConsole({
  initialBatchId,
}: {
  initialBatchId?: string;
} = {}) {
  const { state, actions } = useAuditSession("psi");
  const { batch, batchId, connection, running, cancelling } = state;
  const { watch } = actions;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Deep link: hand the batch to the session (`watch` is stable — runs once per id).
  useEffect(() => {
    if (initialBatchId) watch(initialBatchId);
  }, [initialBatchId, watch]);

  // A new run (or a dismissal) invalidates the detail-sheet selection.
  const [trackedBatchId, setTrackedBatchId] = useState(batchId);
  if (batchId !== trackedBatchId) {
    setTrackedBatchId(batchId);
    setSelectedId(null);
    setSheetOpen(false);
  }

  const selectedJob: AuditJob | null =
    (selectedId && batch?.jobs.find((j) => j.id === selectedId)) || null;

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
      <PsiAuditForm
        onSubmit={actions.submit}
        isRunning={running}
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
