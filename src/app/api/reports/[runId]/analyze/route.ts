/**
 * `GET/POST /api/reports/:runId/analyze` — the AI score-analysis endpoint.
 *
 *  - `GET ?category=<cat>` returns `{ analysis: AnalysisResult | null }` as JSON,
 *    spending no tokens — the client uses this to show a saved analysis instantly
 *    on reopen. A cache miss is `{ analysis: null }` with a `200` (not a `404`):
 *    "not analyzed yet" is a normal state, and a `200` keeps the dev console clean.
 *  - `POST { category, force?, provider?, model?, baselineRunId? }` runs
 *    `runAnalysis` on the configured AI provider and streams progress as SSE:
 *    `status` → `tool-use`/`tool-result` → `text-delta` → `fix` → `done` (or a
 *    terminal `error`). On a clean `done` the result is persisted. Without
 *    `force`, a POST replays a saved analysis as a single `done` frame (no model
 *    call). `provider`/`model` override the environment's selection for this one
 *    analysis; all are optional and validated before anything is spawned.
 *
 * `baselineRunId` (ROADMAP Phase E) turns the analysis into a REGRESSION
 * analysis: the audit-level diff of this run against that baseline is computed
 * server-side and fed to the prompt, so the agent explains what changed rather
 * than re-diagnosing the page from scratch.
 *
 * A baseline-grounded analysis is deliberately NEITHER replayed from cache NOR
 * persisted. The saved-analysis key is `(runId, category)`, so storing
 * regression-flavoured text under it would make a later plain "explain my SEO
 * score" replay the wrong artefact — and widening that key to include a baseline
 * means a unique index over a nullable column, where SQLite treats every NULL as
 * distinct and the existing upsert would start writing duplicate rows. Running
 * fresh costs one agent call and keeps the cache honest.
 *
 * SSE framing + teardown mirror `app/api/audits/[id]/stream/route.ts`. POST is
 * consumed by the browser via fetch + a ReadableStream reader (it carries a body,
 * so `EventSource` — GET-only — can't be used). Node runtime only.
 */

import { apiError, badRequest, notFound, serverError } from "@/lib/api/errors";
import { getAnalysis, saveAnalysis } from "@/lib/db/analyses";
import { getRunInputs } from "@/lib/db/persistence";
import { loadRunLhr, MAX_REPORT_BYTES } from "@/lib/reports/loadReport";
import { extractRunDiff } from "@/lib/reports/report-diff";
import type { RunDiff } from "@/lib/reports/diff-types";
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
 * Upper bound on a run id accepted in the body. Ids here are nanoids (21
 * chars); the ceiling exists so an unbounded string never reaches a lookup, not
 * because any particular length is meaningful.
 */
const MAX_RUN_ID_LENGTH = 64;

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
    baselineRunId?: unknown;
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

  // The baseline this run is explained AGAINST (ROADMAP Phase E). Bounded and
  // shape-checked here, but never reflected: it reaches nothing but
  // `getRunReport`, which is a parameterised lookup, so it can no more address a
  // file than the route parameter can.
  let baselineRunId: string | undefined;
  if (body.baselineRunId !== undefined && body.baselineRunId !== null) {
    if (
      typeof body.baselineRunId !== "string" ||
      body.baselineRunId.trim().length === 0 ||
      body.baselineRunId.length > MAX_RUN_ID_LENGTH
    ) {
      return badRequest(
        "invalid_baseline",
        '"baselineRunId" must be a run id.',
      );
    }
    if (body.baselineRunId.trim() === runId) {
      return badRequest(
        "same_run",
        "The baseline and the analyzed run must be two different runs.",
      );
    }
    baselineRunId = body.baselineRunId.trim();
  }

  // Keyed WITHOUT the baseline, deliberately.
  //
  // A regression analysis is a different artefact from a plain one, so it is
  // tempting to give it its own slot — and this route did, until Phase E's
  // security review pointed out what that costs (L5). This map is the only
  // concurrency bound on an expensive provider process, and widening the key
  // removes it: switching the baseline picker and re-clicking "Explain this
  // change" would claim a fresh slot each time, so N baselines in history means
  // N concurrent agents under the 5-minute timeout. Accidental misuse, not an
  // attacker path (the request gate refuses a cross-origin POST), but the whole
  // point of the guard is to survive accidents.
  //
  // So one analysis per (run, category) at a time, whatever it is grounded in.
  // The cost is that a plain and a baseline-grounded analysis of the same
  // category cannot run at once; the 409's wording is true of both.
  const key = `${runId}:${category}`;
  if (inFlight.has(key)) {
    return apiError(
      409,
      "analysis_in_progress",
      `A ${category} analysis for this run is already running.`,
    );
  }

  // Replay a saved analysis without spawning the agent (unless forced). A
  // baseline-grounded analysis never replays — see the module docblock.
  const saved = force || baselineRunId ? null : getAnalysis(runId, category);

  // Load the LHR only when we'll actually run. The read itself — disk first,
  // then the in-memory queue, with the DB-resolved path and the peak-memory
  // ceiling — lives in `@/lib/reports/loadReport`, shared with the trace and
  // diff routes so all three keep one posture.
  let lhr: LighthouseResult | null = null;
  let diff: RunDiff | null = null;
  if (!saved) {
    // Halved when a baseline is in play, because both reports are then held —
    // and parsed — at the same moment.
    const maxBytes = baselineRunId ? MAX_REPORT_BYTES / 2 : MAX_REPORT_BYTES;
    const loaded = await loadRunLhr(runId, { maxBytes });
    if (loaded.status === "error") {
      if (loaded.reason === "not_found") {
        return notFound(
          "report_not_found",
          "No completed report found for that run.",
        );
      }
      return serverError(
        "report_unreadable",
        "The stored report for that run could not be read.",
      );
    }
    lhr = loaded.lhr;
    if (!lhrHasCategory(lhr, category)) {
      return badRequest(
        "category_not_run",
        `This run didn't audit the ${category} category, so there's nothing to analyze.`,
      );
    }

    if (baselineRunId) {
      const baseline = await loadRunLhr(baselineRunId, { maxBytes });
      if (baseline.status === "error") {
        if (baseline.reason === "not_found") {
          return notFound(
            "baseline_not_found",
            "No completed report found for the baseline run.",
          );
        }
        return serverError(
          "report_unreadable",
          "The stored report for the baseline run could not be read.",
        );
      }
      // A diff that cannot be computed must not silently degrade into a plain
      // analysis: the user asked "what changed", and answering a different
      // question without saying so is the dishonest degradation this project
      // refuses. Both ids are the DB-round-tripped ones.
      try {
        diff = extractRunDiff({
          baseline: { lhr: baseline.lhr, runId: baseline.runId },
          comparison: { lhr: loaded.lhr, runId: loaded.runId },
        });
      } catch {
        return serverError(
          "diff_failed",
          "The stored reports for that pair could not be diffed.",
        );
      }
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
        diff,
        provider,
        model,
        signal: analysisAbort.signal,
        onEvent: send,
      })
        .then((result) => {
          // Never cache a regression analysis under the plain `(runId,
          // category)` key — see the module docblock.
          if (!baselineRunId) saveAnalysis(result);
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
