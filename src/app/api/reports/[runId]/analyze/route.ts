/**
 * `GET/POST /api/reports/:runId/analyze` — the AI score-analysis endpoint.
 *
 *  - `GET ?category=<cat>` returns `{ analysis: AnalysisResult | null }` as JSON,
 *    spending no tokens — the client uses this to show a saved analysis instantly
 *    on reopen. A cache miss is `{ analysis: null }` with a `200` (not a `404`):
 *    "not analyzed yet" is a normal state, and a `200` keeps the dev console clean.
 *  - `POST { category, force?, provider?, model? }` runs `runAnalysis` on the
 *    configured AI provider and streams progress as SSE: `status` →
 *    `tool-use`/`tool-result` → `text-delta` → `fix` → `done` (or a terminal
 *    `error`). On a clean `done` the result is persisted. Without `force`, a POST
 *    replays a saved analysis as a single `done` frame (no model call).
 *    `provider`/`model` override the environment's selection for this one
 *    analysis; both are optional and validated before anything is spawned.
 *
 * SSE framing + teardown mirror `app/api/audits/[id]/stream/route.ts`. POST is
 * consumed by the browser via fetch + a ReadableStream reader (it carries a body,
 * so `EventSource` — GET-only — can't be used). Node runtime only.
 */

import { promises as fs } from "node:fs";

import { apiError, badRequest, notFound } from "@/lib/api/errors";
import { getAnalysis, saveAnalysis } from "@/lib/db/analyses";
import { getRunInputs, getRunReport } from "@/lib/db/persistence";
import { isRecord } from "@/lib/lighthouse/parseLhr";
import {
  LIGHTHOUSE_CATEGORIES,
  type FormFactor,
  type LighthouseResult,
} from "@/lib/lighthouse/types";
import { getAuditQueue } from "@/lib/queue/AuditQueue";
import { redactUrlsInText } from "@/lib/redactUrl";
import { MAX_MODEL_ID_LENGTH, MODEL_ID_PATTERN, normalizeProviderId } from "@/lib/analysis/providers/select";
import { AnalysisError, runAnalysis } from "@/lib/analysis/runAnalysis";
import {
  ANALYSIS_PROVIDER_IDS,
  type AnalysisCategory,
  type AnalysisStreamEvent,
} from "@/lib/analysis/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Wall-clock ceiling for one analysis (abort + `analysis_timeout` past this).
 * A *grounded* run fetches several web pages and synthesizes them, so it needs
 * materially longer than a data-only run — default 5 min, override via env.
 */
const ANALYSIS_TIMEOUT_MS = Number(process.env.ANALYSIS_TIMEOUT_MS ?? 300_000);

/**
 * In-flight analyses keyed by `runId:category`, pinned to `globalThis` so it
 * survives Next dev-mode HMR (like the DB/queue handles). Guards a single-user
 * tool against accidental double-submits of the same expensive agent run.
 */
const globalForAnalysis = globalThis as typeof globalThis & {
  __lhAnalysisInflight?: Map<string, AbortController>;
};
const inFlight = (globalForAnalysis.__lhAnalysisInflight ??= new Map<
  string,
  AbortController
>());

/** Narrow an arbitrary value to a valid analysis category. */
function asCategory(value: unknown): AnalysisCategory | null {
  return typeof value === "string" &&
    (LIGHTHOUSE_CATEGORIES as readonly string[]).includes(value)
    ? (value as AnalysisCategory)
    : null;
}

/** Read a persisted report file, returning `null` (not throwing) when absent. */
async function readPersistedFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Best-effort form factor from the LHR config when the run row is unavailable. */
function formFactorFromLhr(lhr: LighthouseResult): FormFactor {
  const config = isRecord(lhr.configSettings) ? lhr.configSettings : {};
  return config.formFactor === "desktop" ? "desktop" : "mobile";
}

/** Whether the LHR actually scored the given category (else there's nothing to analyze). */
function lhrHasCategory(lhr: LighthouseResult, category: AnalysisCategory): boolean {
  return isRecord(lhr.categories) && isRecord(lhr.categories[category]);
}

// --- GET: cached read ------------------------------------------------------

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await params;
  const category = asCategory(new URL(request.url).searchParams.get("category"));
  if (!category) {
    return badRequest(
      "invalid_category",
      `"category" must be one of: ${LIGHTHOUSE_CATEGORIES.join(", ")}.`,
    );
  }

  const saved = getAnalysis(runId, category);
  return Response.json({ analysis: saved ?? null }, { status: 200 });
}

// --- POST: run (or replay) the analysis, streamed as SSE -------------------

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await params;

  let body: {
    category?: unknown;
    force?: unknown;
    provider?: unknown;
    model?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return badRequest("invalid_body", "Request body must be JSON.");
  }
  const category = asCategory(body.category);
  if (!category) {
    return badRequest(
      "invalid_category",
      `"category" must be one of: ${LIGHTHOUSE_CATEGORIES.join(", ")}.`,
    );
  }
  const force = body.force === true;

  // Per-analysis provider/model override. Both are optional: with neither, the
  // engine uses whatever the environment selects (Claude by default).
  let provider: string | undefined;
  if (body.provider !== undefined && body.provider !== null) {
    const normalized = normalizeProviderId(body.provider);
    if (!normalized) {
      return badRequest(
        "invalid_provider",
        `"provider" must be one of: ${ANALYSIS_PROVIDER_IDS.join(", ")}.`,
      );
    }
    provider = normalized;
  }
  let model: string | undefined;
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== "string" || body.model.trim().length === 0) {
      return badRequest("invalid_model", '"model" must be a non-empty string.');
    }
    if (body.model.length > MAX_MODEL_ID_LENGTH) {
      return badRequest(
        "invalid_model",
        `"model" must be at most ${MAX_MODEL_ID_LENGTH} characters.`,
      );
    }
    if (!MODEL_ID_PATTERN.test(body.model.trim())) {
      return badRequest(
        "invalid_model",
        '"model" must be a model id — no spaces or control characters.',
      );
    }
    model = body.model.trim();
  }

  const key = `${runId}:${category}`;
  if (inFlight.has(key)) {
    return apiError(
      409,
      "analysis_in_progress",
      `A ${category} analysis for this run is already running.`,
    );
  }

  // Replay a saved analysis without spawning the agent (unless forced).
  const saved = force ? null : getAnalysis(runId, category);

  // Load the LHR (disk first, then in-memory queue) only when we'll actually run.
  let lhr: LighthouseResult | null = null;
  if (!saved) {
    const persisted = getRunReport(runId);
    if (persisted?.jsonPath) {
      const json = await readPersistedFile(persisted.jsonPath);
      if (json !== null) {
        try {
          lhr = JSON.parse(json) as LighthouseResult;
        } catch {
          lhr = null;
        }
      }
    }
    if (!lhr) {
      lhr = getAuditQueue().getJobResult(runId)?.median.lhr ?? null;
    }
    if (!lhr) {
      return notFound(
        "report_not_found",
        `No completed report found for run "${runId}".`,
      );
    }
    if (!lhrHasCategory(lhr, category)) {
      return badRequest(
        "category_not_run",
        `This run didn't audit the ${category} category, so there's nothing to analyze.`,
      );
    }
  }

  // Resolve the analyzer inputs (device + CrUX field), preferring the persisted
  // row and falling back to the in-memory result, then the LHR.
  const inputs = getRunInputs(runId);
  const memResult = getAuditQueue().getJobResult(runId);
  const formFactor: FormFactor =
    inputs?.formFactor ??
    memResult?.options.formFactor ??
    (lhr ? formFactorFromLhr(lhr) : "mobile");
  const field = inputs?.field ?? memResult?.field ?? null;

  const encoder = new TextEncoder();
  const lhrToAnalyze = lhr;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const analysisAbort = new AbortController();

      const send = (event: AnalysisStreamEvent): void => {
        if (closed) return;
        try {
          const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        } catch {
          closed = true;
        }
      };

      const teardown = (): void => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        inFlight.delete(key);
        request.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      function onAbort(): void {
        analysisAbort.abort();
        teardown();
      }

      // Client already gone before we started.
      if (request.signal.aborted) {
        teardown();
        return;
      }
      request.signal.addEventListener("abort", onAbort, { once: true });

      // Replay path: one `done` frame, no agent.
      if (saved) {
        send({ type: "done", analysis: saved });
        teardown();
        return;
      }

      // Claim the in-flight slot for the live run.
      inFlight.set(key, analysisAbort);

      timer = setTimeout(() => {
        analysisAbort.abort();
        send({
          type: "error",
          code: "analysis_timeout",
          message: `Analysis timed out after ${Math.round(ANALYSIS_TIMEOUT_MS / 1000)}s.`,
        });
        teardown();
      }, ANALYSIS_TIMEOUT_MS);

      runAnalysis({
        runId,
        category,
        lhr: lhrToAnalyze as LighthouseResult,
        formFactor,
        field,
        provider,
        model,
        signal: analysisAbort.signal,
        onEvent: send,
      })
        .then((result) => {
          saveAnalysis(result);
          send({ type: "done", analysis: result });
          teardown();
        })
        .catch((err: unknown) => {
          // Abort (client disconnect / timeout) is already handled by onAbort /
          // the timer — just ensure teardown; never persist a partial run.
          if (analysisAbort.signal.aborted) {
            teardown();
            return;
          }
          if (err instanceof AnalysisError) {
            send({ type: "error", code: err.code, message: err.message });
          } else {
            // Not an AnalysisError, so this text was composed by something
            // upstream of us — scrub any URL before it crosses to the client.
            const message = redactUrlsInText(
              err instanceof Error ? err.message : String(err),
            );
            send({ type: "error", code: "agent_error", message });
          }
          teardown();
        });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
