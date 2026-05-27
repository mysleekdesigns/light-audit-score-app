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
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AuditDetailSheet } from "@/components/audit/audit-detail-sheet";
import { AuditResults } from "@/components/audit/audit-results";
import { NewAuditForm } from "@/components/audit/new-audit-form";
import { useBatchStream } from "@/hooks/useBatchStream";
import {
  ApiError,
  createBatch,
  type CreateBatchRequest,
} from "@/lib/client/auditClient";
import type { AuditJob } from "@/lib/queue/types";

export function AuditConsole() {
  const [batchId, setBatchId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const { batch, connection, isComplete } = useBatchStream(batchId);

  // Fire the completion toast exactly once per batch.
  const toastedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!isComplete || !batch || toastedFor.current === batch.id) return;
    toastedFor.current = batch.id;
    const { done, error, total } = batch.counts;
    if (error === 0) {
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
            />
          ) : null
        }
      />

      <AuditDetailSheet
        job={selectedJob}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
    </div>
  );
}
