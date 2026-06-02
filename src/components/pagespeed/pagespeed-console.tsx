"use client";

/**
 * Client orchestrator for the PageSpeed Insights flow (PSI feature) — the lean
 * sibling of {@link AuditConsole}. Same machinery: POST a batch (tagged
 * `source: "psi"`), subscribe to live progress via {@link useBatchStream}, render
 * the shared {@link AuditResults} grid + {@link AuditDetailSheet}, and toast on
 * completion. It reuses every results component; only the form ({@link PsiAuditForm})
 * and the active-batch key differ from the local console.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AuditDetailSheet } from "@/components/audit/audit-detail-sheet";
import { AuditResults } from "@/components/audit/audit-results";
import { PsiAuditForm } from "@/components/pagespeed/psi-audit-form";
import { useBatchStream } from "@/hooks/useBatchStream";
import {
  ApiError,
  cancelBatch,
  createBatch,
  getBatch,
  type CreateBatchRequest,
} from "@/lib/client/auditClient";
import type { AuditJob } from "@/lib/queue/types";

/**
 * localStorage key holding the PSI batch currently being watched. Kept separate
 * from the local console's key so the two flows reconnect to their own runs.
 */
const ACTIVE_BATCH_KEY = "lh:activePsiBatchId";

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

  // Reconnect on mount to a still-running PSI batch (the queue keeps running
  // server-side regardless of the client), validating it still exists first.
  useEffect(() => {
    if (initialBatchId) return;
    const stored = localStorage.getItem(ACTIVE_BATCH_KEY);
    if (!stored) return;
    let active = true;
    getBatch(stored)
      .then(() => {
        if (active) setBatchId(stored);
      })
      .catch(() => {
        localStorage.removeItem(ACTIVE_BATCH_KEY);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Completion toast (once per batch) + drop the persisted active-batch id.
  const toastedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!isComplete || !batch || toastedFor.current === batch.id) return;
    toastedFor.current = batch.id;
    localStorage.removeItem(ACTIVE_BATCH_KEY);
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
        results={
          batch ? (
            <AuditResults
              batch={batch}
              connection={connection}
              onSelect={handleSelect}
              onCancel={handleCancel}
              cancelling={cancelling}
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
