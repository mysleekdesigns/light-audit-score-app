"use client";

/**
 * `useAnalysisStream` — drive a live AI score analysis over SSE.
 *
 * Unlike `useBatchStream` (which uses the browser `EventSource`), the analyze
 * endpoint is a POST that carries a `{ category }` body, so this hook streams via
 * `fetch` + a `ReadableStream` reader and parses SSE frames manually (see
 * `parseAnalysisSseFrame`). It mirrors `useBatchStream`'s *shape*: typed events
 * folded into state, reset-on-key-change, a terminal close, no auto-reconnect
 * (a dropped stream surfaces a terminal error + a "Re-analyze" affordance).
 *
 * The hook does not start on mount — call `start()` (or `start({ force: true })`
 * to re-run) when the user asks. State resets automatically when `(runId,
 * category)` changes.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { analyzeStreamUrl, parseAnalysisSseFrame } from "@/lib/client/auditClient";
import type {
  AnalysisAuth,
  AnalysisCategory,
  AnalysisMcpStatus,
  AnalysisResult,
  AnalysisStreamEvent,
  Fix,
} from "@/lib/analysis/types";

/** Hook status: idle → connecting → (diagnosing|researching|writing|finalizing) → done|error|cancelled. */
export type AnalysisStatus =
  | "idle"
  | "connecting"
  | "diagnosing"
  | "researching"
  | "writing"
  | "finalizing"
  | "done"
  | "error"
  | "cancelled";

/** One research step in the live log (a research MCP tool call). */
export interface ToolEvent {
  id: string;
  label: string;
  /** True once its tool result arrived. */
  done: boolean;
  /** Whether the tool call succeeded (meaningful once `done`). */
  ok: boolean;
}

export interface UseAnalysisStreamResult {
  status: AnalysisStatus;
  /** Latest human status line (e.g. "Researching fixes on the web…"). */
  statusMessage: string | null;
  /** How the agent authenticated, once known. */
  auth: AnalysisAuth | null;
  /** MCP server connection statuses from the agent's init. */
  mcp: AnalysisMcpStatus[];
  /** Append-only research log. */
  toolEvents: ToolEvent[];
  /** Accumulated diagnosis markdown (replaced by the authoritative text on done). */
  diagnosis: string;
  /** Fixes (filled incrementally, then replaced by the final set on done). */
  fixes: Fix[];
  /** The persisted result, set on `done`. */
  result: AnalysisResult | null;
  /** Terminal error, if any. */
  error: { code: string; message: string } | null;
  /** True while a stream is open. */
  isStreaming: boolean;
  /** Start (or restart) the analysis. `force` re-runs even if one is cached. */
  start: (opts?: { force?: boolean }) => void;
  /** Abort an in-flight analysis. */
  cancel: () => void;
}

const STREAMING_STATUSES: ReadonlySet<AnalysisStatus> = new Set([
  "connecting",
  "diagnosing",
  "researching",
  "writing",
  "finalizing",
]);

/** Map a stream `status` phase onto the hook's status enum. */
function phaseToStatus(phase: string): AnalysisStatus {
  switch (phase) {
    case "preflight":
      return "connecting";
    case "diagnosing":
      return "diagnosing";
    case "researching":
      return "researching";
    case "writing":
      return "writing";
    case "finalizing":
      return "finalizing";
    default:
      return "connecting";
  }
}

export function useAnalysisStream(
  runId: string,
  category: AnalysisCategory,
): UseAnalysisStreamResult {
  const [status, setStatus] = useState<AnalysisStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [auth, setAuth] = useState<AnalysisAuth | null>(null);
  const [mcp, setMcp] = useState<AnalysisMcpStatus[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [diagnosis, setDiagnosis] = useState("");
  const [fixes, setFixes] = useState<Fix[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // Mirror of the accumulated diagnosis so text deltas don't depend on render state.
  const diagnosisRef = useRef("");

  const clearState = useCallback(() => {
    diagnosisRef.current = "";
    setStatusMessage(null);
    setAuth(null);
    setMcp([]);
    setToolEvents([]);
    setDiagnosis("");
    setFixes([]);
    setResult(null);
    setError(null);
  }, []);

  // Reset synchronously during render when the target changes (React's
  // recommended alternative to a reset-in-effect), aborting any open stream.
  const key = `${runId}:${category}`;
  const [trackedKey, setTrackedKey] = useState(key);
  if (key !== trackedKey) {
    setTrackedKey(key);
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
    clearState();
  }

  /** Fold one stream event into state. */
  const apply = useCallback((event: AnalysisStreamEvent): void => {
    switch (event.type) {
      case "status":
        setStatus(phaseToStatus(event.phase));
        if (event.message !== undefined) setStatusMessage(event.message);
        if (event.auth) setAuth(event.auth);
        if (event.mcp) setMcp(event.mcp);
        return;
      case "tool-use":
        setToolEvents((prev) => [
          ...prev,
          { id: event.id, label: event.label, done: false, ok: true },
        ]);
        return;
      case "tool-result":
        setToolEvents((prev) =>
          prev.map((t) => (t.id === event.id ? { ...t, done: true, ok: event.ok } : t)),
        );
        return;
      case "text-delta":
        diagnosisRef.current += event.delta;
        setDiagnosis(diagnosisRef.current);
        return;
      case "fix":
        setFixes((prev) => {
          const next = [...prev];
          next[event.index] = event.fix;
          return next;
        });
        return;
      case "done":
        setResult(event.analysis);
        setFixes(event.analysis.fixes);
        if (event.analysis.diagnosis) {
          diagnosisRef.current = event.analysis.diagnosis;
          setDiagnosis(event.analysis.diagnosis);
        }
        setStatus("done");
        return;
      case "error":
        setError({ code: event.code, message: event.message });
        setStatus("error");
        return;
    }
  }, []);

  const start = useCallback(
    (opts?: { force?: boolean }) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      clearState();
      setStatus("connecting");

      void (async () => {
        try {
          const response = await fetch(analyzeStreamUrl(runId), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category, force: opts?.force === true }),
            signal: ac.signal,
          });

          if (!response.ok || !response.body) {
            let code = "request_failed";
            let message = `Analysis request failed (${response.status}).`;
            try {
              const envelope = (await response.json()) as {
                error?: { code?: string; message?: string };
              };
              code = envelope.error?.code ?? code;
              message = envelope.error?.message ?? message;
            } catch {
              // Non-JSON body — keep the generic message.
            }
            setError({ code, message });
            setStatus("error");
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf("\n\n");
            while (boundary !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const event = parseAnalysisSseFrame(frame);
              if (event) apply(event);
              boundary = buffer.indexOf("\n\n");
            }
          }
          const tail = parseAnalysisSseFrame(buffer);
          if (tail) apply(tail);
        } catch (err) {
          if (ac.signal.aborted) {
            setStatus("cancelled");
            return;
          }
          setError({
            code: "network_error",
            message: err instanceof Error ? err.message : String(err),
          });
          setStatus("error");
        }
      })();
    },
    [runId, category, apply, clearState],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("cancelled");
  }, []);

  // Abort any open stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    status,
    statusMessage,
    auth,
    mcp,
    toolEvents,
    diagnosis,
    fixes,
    result,
    error,
    isStreaming: STREAMING_STATUSES.has(status),
    start,
    cancel,
  };
}
