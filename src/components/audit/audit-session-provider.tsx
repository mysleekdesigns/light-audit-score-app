"use client";

/**
 * `AuditSessionProvider` — owns the live audit session for each engine (local
 * Lighthouse and PageSpeed Insights) at the ROOT LAYOUT, so it survives in-app
 * navigation.
 *
 * Why here and not in the page: Next.js layouts persist across route changes
 * (they keep state and never remount); pages and everything under them do not.
 * While the watched batch, its SSE subscription and the completion toast lived
 * in the page-level console, every trip to History or Settings tore the stream
 * down, and the return trip rebuilt the console from scratch — an empty form,
 * then a round-trip to the API before the results reappeared. The queue itself
 * never stopped (the server runs batches regardless of the client), but the UI
 * looked reset. With the session here the EventSource stays open wherever the
 * user is, the console renders from live state the instant it mounts, and the
 * completion toast fires on whatever page they're on.
 *
 * Persistence: the watched batch id is mirrored to `localStorage` per engine so
 * a full reload (or a fresh tab) re-attaches too. The pointer survives
 * completion (a finished run is restorable) and is dropped only on
 * Archive/Clear or when a new run replaces it. Attaching to a stored id first
 * validates it with `GET /api/audits/:id` — a server restart drops the
 * in-memory queue, and `EventSource` fails permanently (no retry) on a 404.
 *
 * Contract: consoles read {@link AuditSessionState} and call
 * {@link AuditSessionActions}; they never learn how the stream or storage work.
 */

import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { type StreamConnection, useBatchStream } from "@/hooks/useBatchStream";
import {
  ApiError,
  cancelBatch,
  createBatch,
  deleteBatch,
  getBatch,
  type CreateBatchRequest,
} from "@/lib/client/auditClient";
import type { Batch, BatchStatus } from "@/lib/queue/types";

/** The two audit engines, each with its own independent session. */
export type AuditEngine = "local" | "psi";

export interface AuditSessionState {
  /** The batch being watched (live or restored), or `null` for a clean console. */
  batchId: string | null;
  /** Latest snapshot of that batch, `null` until the stream delivers one. */
  batch: Batch | null;
  connection: StreamConnection;
  /** `true` once the watched batch reached a terminal status. */
  isComplete: boolean;
  /** A submit is in flight, or the watched batch hasn't finished yet. */
  running: boolean;
  submitting: boolean;
  cancelling: boolean;
}

export interface AuditSessionActions {
  /** Create a batch from the form and start watching it. Toasts on failure. */
  submit: (request: CreateBatchRequest) => Promise<void>;
  /** Cancel the batch in flight (the stream delivers the terminal state). */
  cancel: () => Promise<void>;
  /** Dismiss a finished batch from the console; it stays in History. */
  archive: () => void;
  /** Delete the finished batch from History and reset the console. Throws on failure. */
  clear: () => Promise<void>;
  /**
   * Watch an existing batch — the `?watch=<id>` deep link a Re-run lands on.
   * Persisted exactly like a form-started run, so it too survives navigation.
   * Stable identity: safe as an effect dependency.
   */
  watch: (batchId: string) => void;
}

export interface AuditSession {
  state: AuditSessionState;
  actions: AuditSessionActions;
}

/** Everything about one engine that differs: its storage key and its copy. */
interface EngineProfile {
  /**
   * `localStorage` key for the watched batch id. Unchanged from the pre-provider
   * consoles so existing pointers keep restoring.
   */
  storageKey: string;
  queued: (jobs: number, concurrency: number) => string;
  submitFailed: string;
  cancelFailed: string;
  cleared: string;
  cancelled: (done: number, total: number) => string;
  complete: (done: number, total: number) => string;
  failed: (total: number) => string;
  partial: (done: number, error: number, total: number) => string;
}

const ENGINES: Record<AuditEngine, EngineProfile> = {
  local: {
    storageKey: "lh:activeBatchId",
    queued: (jobs, concurrency) =>
      `Queued ${jobs} ${jobs === 1 ? "page" : "pages"} at concurrency ${concurrency}.`,
    submitFailed: "Could not start the audit. Is the dev server running?",
    cancelFailed: "Could not cancel the audit.",
    cleared: "Run cleared from history.",
    cancelled: (done, total) =>
      `Audit cancelled — ${done} of ${total} pages scored before stopping.`,
    complete: (done, total) => `Audit complete — ${done}/${total} pages scored.`,
    failed: (total) => `Audit failed — all ${total} pages errored.`,
    partial: (done, error, total) =>
      `Audit complete — ${done} scored, ${error} failed of ${total}.`,
  },
  psi: {
    storageKey: "lh:activePsiBatchId",
    queued: (jobs) =>
      `Queued ${jobs} ${jobs === 1 ? "URL" : "URLs"} for PageSpeed Insights.`,
    submitFailed: "Could not start the PageSpeed run. Is the dev server running?",
    cancelFailed: "Could not cancel the run.",
    cleared: "PageSpeed run cleared from history.",
    cancelled: (done, total) =>
      `PageSpeed cancelled — ${done} of ${total} scored before stopping.`,
    complete: (done, total) => `PageSpeed complete — ${done}/${total} URLs scored.`,
    failed: (total) => `PageSpeed failed — all ${total} URLs errored.`,
    partial: (done, error, total) =>
      `PageSpeed complete — ${done} scored, ${error} failed of ${total}.`,
  },
};

/** Terminal batch states — a batch in one of these has finished server-side. */
const TERMINAL_BATCH_STATUSES = new Set<BatchStatus>([
  "completed",
  "completed_with_errors",
  "cancelled",
]);

function isTerminalBatchStatus(status: BatchStatus): boolean {
  return TERMINAL_BATCH_STATUSES.has(status);
}

// `localStorage` throws in private mode / when disabled; the session must not.
function readPointer(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePointer(key: string, id: string): void {
  try {
    window.localStorage.setItem(key, id);
  } catch {
    // Not persisted — the in-memory session still works until reload.
  }
}

function clearPointer(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

/** One engine's session: the watched batch, its stream, and the actions on it. */
function useEngineSession(engine: AuditEngine): AuditSession {
  const profile = ENGINES[engine];
  const { storageKey } = profile;

  const [batchId, setBatchId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const { batch, connection, isComplete } = useBatchStream(batchId);

  // The batch id we've already toasted completion for, so the toast fires exactly
  // once per batch — and never for a run that was already finished when we
  // attached to it (a restore after reload, or a deep link to an old run).
  const toastedFor = useRef<string | null>(null);

  /**
   * Attach to a batch that already exists server-side, validating it first. The
   * pointer is re-read when the request settles: if a newer run, watch, or
   * dismissal replaced it in the meantime, this attach is stale and is dropped
   * — so the stored id and the watched id can never disagree.
   */
  const attach = useCallback(
    (id: string) => {
      getBatch(id)
        .then((restored) => {
          if (readPointer(storageKey) !== id) return;
          if (isTerminalBatchStatus(restored.status)) toastedFor.current = id;
          setBatchId(id);
        })
        .catch(() => {
          // Gone (typically a server restart emptied the queue) — forget it.
          if (readPointer(storageKey) === id) clearPointer(storageKey);
        });
    },
    [storageKey],
  );

  // Restore on app load: re-attach to the batch this tab (or a previous one) was
  // watching. Runs once — the provider lives in the root layout — which is what
  // makes the console pick up mid-run after a reload.
  useEffect(() => {
    const stored = readPointer(storageKey);
    if (stored) attach(stored);
  }, [attach, storageKey]);

  // Completion toast — fires on whichever page the user is on.
  useEffect(() => {
    if (!isComplete || !batch || toastedFor.current === batch.id) return;
    toastedFor.current = batch.id;
    const { done, error, total } = batch.counts;
    if (batch.status === "cancelled") {
      toast.info(profile.cancelled(done, total));
    } else if (error === 0) {
      toast.success(profile.complete(done, total));
    } else if (done === 0) {
      toast.error(profile.failed(total));
    } else {
      toast.warning(profile.partial(done, error, total));
    }
  }, [isComplete, batch, profile]);

  const submit = useCallback(
    async (request: CreateBatchRequest) => {
      setSubmitting(true);
      try {
        const created = await createBatch(request);
        toastedFor.current = null;
        // Persist first so any in-flight attach for an older id drops itself.
        writePointer(storageKey, created.id);
        setBatchId(created.id);
        toast.info(profile.queued(created.jobs.length, created.concurrency));
      } catch (err) {
        const message =
          err instanceof ApiError
            ? (err.issues[0]?.message ?? err.message)
            : profile.submitFailed;
        toast.error(message);
      } finally {
        setSubmitting(false);
      }
    },
    [profile, storageKey],
  );

  const cancel = useCallback(async () => {
    if (!batchId || cancelling) return;
    setCancelling(true);
    try {
      // The server flips the batch to `cancelled` and emits `batch-cancelled`,
      // which the stream delivers — that drives the UI to terminal; nothing is
      // mutated optimistically here. The pointer is kept: a cancelled batch is
      // terminal and restorable, and clears on dismissal or a new run.
      await cancelBatch(batchId);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : profile.cancelFailed);
    } finally {
      setCancelling(false);
    }
  }, [batchId, cancelling, profile]);

  // Archive: dismiss without touching the backend — the run stays in History.
  const archive = useCallback(() => {
    clearPointer(storageKey);
    setBatchId(null);
  }, [storageKey]);

  // Clear: destructively delete the batch from History, then reset exactly like
  // Archive. Left to throw on failure so the confirming AlertDialog in
  // AuditResults catches it and toasts.
  const clear = useCallback(async () => {
    if (!batchId) return;
    await deleteBatch(batchId);
    clearPointer(storageKey);
    setBatchId(null);
    toast.success(profile.cleared);
  }, [batchId, profile, storageKey]);

  const watch = useCallback(
    (id: string) => {
      writePointer(storageKey, id);
      attach(id);
    },
    [attach, storageKey],
  );

  const state = useMemo<AuditSessionState>(
    () => ({
      batchId,
      batch,
      connection,
      isComplete,
      running: submitting || (batchId !== null && !isComplete),
      submitting,
      cancelling,
    }),
    [batchId, batch, connection, isComplete, submitting, cancelling],
  );

  const actions = useMemo<AuditSessionActions>(
    () => ({ submit, cancel, archive, clear, watch }),
    [submit, cancel, archive, clear, watch],
  );

  return useMemo(() => ({ state, actions }), [state, actions]);
}

const AuditSessionContext = createContext<Record<AuditEngine, AuditSession> | null>(
  null,
);

/** Mount once, in the root layout, above every page that runs or watches audits. */
export function AuditSessionProvider({ children }: { children: ReactNode }) {
  const local = useEngineSession("local");
  const psi = useEngineSession("psi");
  const value = useMemo(() => ({ local, psi }), [local, psi]);
  return <AuditSessionContext value={value}>{children}</AuditSessionContext>;
}

/** The session for one engine. Throws outside {@link AuditSessionProvider}. */
export function useAuditSession(engine: AuditEngine): AuditSession {
  const sessions = use(AuditSessionContext);
  if (!sessions) {
    throw new Error("useAuditSession must be used within <AuditSessionProvider>.");
  }
  return sessions[engine];
}
