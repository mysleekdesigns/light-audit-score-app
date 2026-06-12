"use client";

/**
 * Client orchestrator for the PageSpeed Insights flow (PSI feature) — the lean
 * sibling of {@link AuditConsole}. Same machinery: POST a batch (tagged
 * `source: "psi"`), subscribe to live progress via {@link useBatchStream}, render
 * the shared {@link AuditResults} grid + {@link AuditDetailSheet}, and toast on
 * completion. It reuses every results component; only the form ({@link PsiAuditForm})
 * and the active-batch key differ from the local console.
 */

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AuditDetailSheet } from "@/components/audit/audit-detail-sheet";
import { AuditResults } from "@/components/audit/audit-results";
import { PsiAuditForm } from "@/components/pagespeed/psi-audit-form";
import { useBatchStream } from "@/hooks/useBatchStream";
import {
  ApiError,
  cancelBatch,
  createBatch,
  deleteBatch,
  getBatch,
  type CreateBatchRequest,
} from "@/lib/client/auditClient";
import type { AuditJob, BatchStatus } from "@/lib/queue/types";

/**
 * localStorage key holding the PSI batch currently being watched. Kept separate
 * from the local console's key so the two flows reconnect to their own runs. The
 * pointer now survives completion (the reconnect effect restores a finished run
 * too); it is dropped only on an explicit dismissal (Phase 16's Archive/Clear) or
 * when a new run overwrites it.
 */
const ACTIVE_BATCH_KEY = "lh:activePsiBatchId";

/** Terminal batch states — a batch in one of these has finished server-side. */
const TERMINAL_BATCH_STATUSES = new Set<BatchStatus>([
  "completed",
  "completed_with_errors",
  "cancelled",
]);
function isTerminalBatchStatus(status: BatchStatus): boolean {
  return TERMINAL_BATCH_STATUSES.has(status);
}

export function PageSpeedConsole({
  initialBatchId,
}: {
  initialBatchId?: string;
} = {}) {
  const [batchId, setBatchId] = useState<string | null>(initialBatchId ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const { batch, connection, isComplete } = useBatchStream(batchId);

  // Tracks the batch id we've already toasted completion for, so the toast fires
  // exactly once per batch. The persisted active-batch id is intentionally KEPT
  // through completion so the reconnect effect can restore a finished run on return;
  // it is dropped only on an explicit dismissal (Phase 16's Archive/Clear) or when a
  // new run overwrites it.
  const toastedFor = useRef<string | null>(null);

  // Restoring a finished run must not re-fire the completion toast. This effect-event
  // attaches the watched batch and, when it's already terminal, pre-seeds the toast
  // guard first (a still-running batch is left unseeded so it still toasts on its
  // eventual completion). Kept as a useEffectEvent so the guard mutation stays out of
  // reactive effect scope and shares the single `toastedFor` ref with the toast effect.
  const onReconnect = useEffectEvent((restored: { status: BatchStatus }, stored: string) => {
    if (isTerminalBatchStatus(restored.status)) {
      toastedFor.current = stored;
    }
    setBatchId(stored);
  });

  // Reconnect on mount to a still-running PSI batch (the queue keeps running
  // server-side regardless of the client), validating it still exists first.
  useEffect(() => {
    if (initialBatchId) return;
    const stored = localStorage.getItem(ACTIVE_BATCH_KEY);
    if (!stored) return;
    let active = true;
    getBatch(stored)
      .then((restored) => {
        if (active) onReconnect(restored, stored);
      })
      .catch(() => {
        localStorage.removeItem(ACTIVE_BATCH_KEY);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isComplete || !batch || toastedFor.current === batch.id) return;
    toastedFor.current = batch.id;
    const { done, error, total } = batch.counts;
    if (batch.status === "cancelled") {
      toast.info(`PageSpeed cancelled — ${done} of ${total} scored before stopping.`);
    } else if (error === 0) {
      toast.success(`PageSpeed complete — ${done}/${total} URLs scored.`);
    } else if (done === 0) {
      toast.error(`PageSpeed failed — all ${total} URLs errored.`);
    } else {
      toast.warning(`PageSpeed complete — ${done} scored, ${error} failed of ${total}.`);
    }
  }, [isComplete, batch]);

  async function handleSubmit(request: CreateBatchRequest) {
    setSubmitting(true);
    try {
      const created = await createBatch(request);
      toastedFor.current = null;
      setSelectedId(null);
      setSheetOpen(false);
      setBatchId(created.id);
      localStorage.setItem(ACTIVE_BATCH_KEY, created.id);
      toast.info(
        `Queued ${created.jobs.length} ${created.jobs.length === 1 ? "URL" : "URLs"} for PageSpeed Insights.`,
      );
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.issues[0]?.message ?? err.message
          : "Could not start the PageSpeed run. Is the dev server running?";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!batchId || cancelling) return;
    setCancelling(true);
    try {
      await cancelBatch(batchId);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Could not cancel the run.";
      toast.error(message);
    } finally {
      setCancelling(false);
    }
  }

  // Archive: dismiss a finished PSI batch from the console without touching the
  // backend — the run stays in History. Drops the active-batch pointer and resets
  // the detail sheet so the console returns to a clean form.
  function handleArchive() {
    setBatchId(null);
    localStorage.removeItem(ACTIVE_BATCH_KEY);
    setSelectedId(null);
    setSheetOpen(false);
  }

  // Clear: destructively delete a finished PSI batch from History, then reset the
  // console exactly like Archive. Left to throw on failure so the AlertDialog in
  // AuditResults catches it and toasts; the destructive confirm itself lives in
  // that view layer (mirroring DeleteRunButton in history-table.tsx).
  async function handleClear() {
    if (!batchId) return;
    await deleteBatch(batchId);
    setBatchId(null);
    localStorage.removeItem(ACTIVE_BATCH_KEY);
    setSelectedId(null);
    setSheetOpen(false);
    toast.success("PageSpeed run cleared from history.");
  }

  const running = submitting || (batchId !== null && !isComplete);

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
        onSubmit={handleSubmit}
        isRunning={running}
        hasBatch={batch != null}
        results={
          batch ? (
            <AuditResults
              batch={batch}
              connection={connection}
              onSelect={handleSelect}
              onCancel={handleCancel}
              cancelling={cancelling}
              onArchive={handleArchive}
              onClear={handleClear}
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
