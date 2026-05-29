"use client";

/**
 * Client orchestrator for the New Audit flow (PRD §6 Phase 3).
 *
 * Owns the interactive state that ties the three Phase-3 slices together:
 *  - renders {@link NewAuditForm}; on submit it POSTs via `createBatch`, stores the
 *    returned batch id, and subscribes to live progress with {@link useBatchStream};
 *  - renders {@link AuditResults} (the live per-URL grid) off the streamed batch;
 *  - opens {@link AuditDetailSheet} for a selected job;
 *  - raises sonner toasts on submit failure and on batch completion.
 *
 * `initialBatchId` (PRD §6 Phase 13) lets a Re-run elsewhere (Batch summary /
 * History) deep-link here via `/?watch=<batchId>` to watch the re-run stream live
 * — it just seeds the watched batch; the SSE handler replays a snapshot on connect.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AuditDetailSheet } from "@/components/audit/audit-detail-sheet";
import { AuditResults } from "@/components/audit/audit-results";
import { NewAuditForm } from "@/components/audit/new-audit-form";
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
 * localStorage key holding the id of the batch currently being watched. Persisted
 * so navigating away from `/` and back reconnects to the still-running server-side
 * batch (the queue keeps running regardless of the client) instead of showing an
 * empty form. Cleared once the batch reaches a terminal state.
 */
const ACTIVE_BATCH_KEY = "lh:activeBatchId";

export function AuditConsole({
  initialBatchId,
}: {
  /** Seed a batch to watch live (e.g. a Re-run deep-linked via `/?watch=<id>`). */
  initialBatchId?: string;
} = {}) {
  const [batchId, setBatchId] = useState<string | null>(initialBatchId ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const { batch, connection, isComplete } = useBatchStream(batchId);

  // Reconnect on mount: if we weren't deep-linked to a batch (`?watch=`), look for
  // one we were watching before navigating away and re-attach to it — but only if
  // it still exists server-side (a restart drops the in-memory queue). Validating
  // with `getBatch` up front avoids EventSource's permanent-failure-on-404 quirk.
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
    // Run once on mount; `initialBatchId` is a stable prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fire the completion toast exactly once per batch, and drop the persisted
  // active-batch id now the batch is terminal (so a later remount won't reconnect
  // to a finished run).
  const toastedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!isComplete || !batch || toastedFor.current === batch.id) return;
    toastedFor.current = batch.id;
    localStorage.removeItem(ACTIVE_BATCH_KEY);
    const { done, error, total } = batch.counts;
    if (batch.status === "cancelled") {
      toast.info(`Audit cancelled — ${done} of ${total} pages scored before stopping.`);
    } else if (error === 0) {
      toast.success(`Audit complete — ${done}/${total} pages scored.`);
    } else if (done === 0) {
      toast.error(`Audit failed — all ${total} pages errored.`);
    } else {
      toast.warning(
        `Audit complete — ${done} scored, ${error} failed of ${total}.`,
      );
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
      // Persist so navigating away and back reconnects to this run.
      localStorage.setItem(ACTIVE_BATCH_KEY, created.id);
      toast.info(
        `Queued ${created.jobs.length} ${created.jobs.length === 1 ? "page" : "pages"} at concurrency ${created.concurrency}.`,
      );
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.issues[0]?.message ?? err.message
          : "Could not start the audit. Is the dev server running?";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!batchId || cancelling) return;
    setCancelling(true);
    try {
      // The server flips the batch to `cancelled` and emits `batch-cancelled`,
      // which the SSE stream delivers — that drives the UI to terminal. We don't
      // optimistically mutate here. localStorage is cleared by the terminal effect.
      await cancelBatch(batchId);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Could not cancel the audit.";
      toast.error(message);
    } finally {
      setCancelling(false);
    }
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

  // A batch is "in flight" while we have one that hasn't reached a terminal state.
  const running = submitting || (batchId !== null && !isComplete);

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
        onSubmit={handleSubmit}
        isRunning={running}
        latestBenchmarkIndex={latestBenchmarkIndex}
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
