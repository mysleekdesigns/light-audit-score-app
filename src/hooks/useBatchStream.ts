"use client";

/**
 * `useBatchStream` — subscribe to a batch's live progress over SSE (PRD §6 Phase 3).
 *
 * Wraps the browser `EventSource` against `GET /api/audits/:id/stream`, whose
 * protocol (see the stream route) is: a `batch-snapshot` on connect, then
 * incremental `job-started` / `job-completed` / `job-failed` events, then a final
 * `batch-completed` (after which the server closes the stream).
 *
 * Reconnect: `EventSource` reconnects automatically on a *transient* drop, and on
 * reconnect the server re-sends a fresh `batch-snapshot`, so state self-heals — we
 * surface that as a `reconnecting` connection phase. Once the batch is terminal
 * (a `batch-completed` event, or a snapshot whose status is already terminal) we
 * close the source ourselves so the clean server-side close is not mistaken for a
 * dropped connection and retried forever.
 */

import { useEffect, useRef, useState } from "react";

import type {
  Batch,
  BatchStatus,
  ProgressEvent as AuditProgressEvent,
} from "@/lib/queue/types";

/** Connection lifecycle surfaced to the UI (distinct from the batch's own status). */
export type StreamConnection =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface UseBatchStreamResult {
  /** Latest known batch snapshot, or `null` until the first event (or when no id). */
  batch: Batch | null;
  /** SSE connection phase. */
  connection: StreamConnection;
  /** `true` once the batch reached a terminal status. */
  isComplete: boolean;
  /** Last connection error message, if any (cleared on successful reconnect). */
  error: string | null;
}

const TERMINAL_STATUSES = new Set<BatchStatus>([
  "completed",
  "completed_with_errors",
  "cancelled",
]);

/** Named SSE events forwarded by the stream route (must match `ProgressEvent["type"]`). */
const EVENT_TYPES = [
  "batch-snapshot",
  "job-started",
  "job-completed",
  "job-failed",
  "batch-completed",
  "batch-cancelled",
] as const;

/**
 * Fold one progress event into the previous batch state. Snapshot/completed events
 * carry the full batch (authoritative); incremental job events patch the matching
 * job + counts and nudge a still-`queued` batch into `running`.
 */
function reduce(prev: Batch | null, event: AuditProgressEvent): Batch | null {
  switch (event.type) {
    case "batch-snapshot":
    case "batch-completed":
    case "batch-cancelled":
      return event.batch;
    case "job-started":
    case "job-completed":
    case "job-failed": {
      if (!prev || prev.id !== event.batchId) return prev;
      return {
        ...prev,
        status: prev.status === "queued" ? "running" : prev.status,
        counts: event.counts,
        jobs: prev.jobs.map((j) => (j.id === event.job.id ? event.job : j)),
      };
    }
    default:
      return prev;
  }
}

export function useBatchStream(batchId: string | null): UseBatchStreamResult {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [connection, setConnection] = useState<StreamConnection>(
    batchId ? "connecting" : "idle",
  );
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mirror of the latest batch so the SSE handler can fold events without the
  // effect depending on `batch` (which would re-subscribe on every update).
  const batchRef = useRef<Batch | null>(null);

  // Reset derived state synchronously *during render* when the id changes
  // (React's recommended alternative to resetting via a setState-in-effect).
  const [trackedId, setTrackedId] = useState(batchId);
  if (batchId !== trackedId) {
    setTrackedId(batchId);
    setBatch(null);
    setIsComplete(false);
    setError(null);
    setConnection(batchId ? "connecting" : "idle");
  }

  useEffect(() => {
    if (!batchId) return;
    batchRef.current = null;
    let completed = false;

    const source = new EventSource(
      `/api/audits/${encodeURIComponent(batchId)}/stream`,
    );

    const finish = (next: Batch) => {
      completed = true;
      batchRef.current = next;
      setBatch(next);
      setIsComplete(true);
      setConnection("closed");
      source.close();
    };

    const onEvent = (e: MessageEvent) => {
      let event: AuditProgressEvent;
      try {
        event = JSON.parse(e.data) as AuditProgressEvent;
      } catch {
        return; // Ignore malformed frames rather than crash the stream.
      }
      setError(null);
      setConnection("open");

      if (event.type === "batch-completed" || event.type === "batch-cancelled") {
        finish(event.batch);
        return;
      }

      const next = reduce(batchRef.current, event);
      if (!next) return;
      batchRef.current = next;
      setBatch(next);
      // A snapshot can itself be terminal (the route sends it, then closes).
      if (event.type === "batch-snapshot" && TERMINAL_STATUSES.has(next.status)) {
        finish(next);
      }
    };

    source.onopen = () => {
      setConnection("open");
      setError(null);
    };
    source.onerror = () => {
      if (completed) return;
      // A non-200 response (e.g. the batch is gone after a server restart) puts
      // the source in CLOSED with no auto-retry — surface it as a terminal close
      // so callers can drop a stale id rather than spin on "reconnecting".
      if (source.readyState === EventSource.CLOSED) {
        setConnection("closed");
        setError("Stream closed — the batch is no longer available.");
        return;
      }
      // Otherwise EventSource auto-retries; reflect that rather than treating it as fatal.
      setConnection("reconnecting");
      setError("Connection interrupted — reconnecting…");
    };
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, onEvent as EventListener);
    }

    return () => {
      for (const type of EVENT_TYPES) {
        source.removeEventListener(type, onEvent as EventListener);
      }
      source.close();
    };
  }, [batchId]);

  return { batch, connection, isComplete, error };
}
