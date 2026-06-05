/**
 * PageSpeed Insights engine — the `RunAudit` seam implemented over Google's
 * hosted PSI API instead of local Chrome (PSI feature).
 *
 * It is a plain HTTPS `fetch`: no Chrome, no process-global Lighthouse state, so
 * unlike the local engine it runs IN-PROCESS in the Next server (no worker fork)
 * and gets `AbortSignal` cancellation for free. It MUST NOT import
 * `lighthouse`/`chrome-launcher` — it reuses the pure `parseLhr` on PSI's
 * `lighthouseResult` (same LHR shape; PSI runs Lighthouse 13) and adds the CrUX
 * field data the local engine can't produce.
 *
 * Returns the same {@link AuditResult} the local engine does — median-of-N over
 * `options.runs` PSI calls (PSI lab scores vary call-to-call, so this stabilises
 * them exactly as the local engine does), the median run's PSI response as
 * `median.lhr`, with `source: "psi"` and optional `field` — so the queue,
 * persistence, reports, and results UI treat it identically.
 *
 * PSI's lab conditions are FIXED Google-side (no throttling / CPU-slowdown
 * parameter exists in the API), so `options` levers other than runs / formFactor /
 * categories / locale are nominal; cross-URL parallelism is the queue's
 * concurrency knob, not anything PSI itself accepts.
 */

import { runtimeErrorMessage } from "@/lib/lighthouse/diagnose";
import { asString, isRecord, parseLhr } from "@/lib/lighthouse/parseLhr";
import { selectMedianRun } from "@/lib/lighthouse/select-median-run";
import type {
  AuditOptions,
  AuditResult,
  LighthouseResult,
} from "@/lib/lighthouse/types";
import { buildPsiUrl } from "@/lib/pagespeed/buildPsiUrl";
import {
  getPsiApiKey,
  PSI_MAX_ATTEMPTS,
  PSI_REQUEST_TIMEOUT_MS,
  PSI_RETRY_BASE_MS,
} from "@/lib/pagespeed/config";
import { parseFieldData } from "@/lib/pagespeed/parseFieldData";

/** Abortable sleep — rejects (so the retry loop unwinds) if `signal` fires mid-wait. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    };
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Best-effort extraction of Google's JSON error message from a non-OK response. */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    if (isRecord(body) && isRecord(body.error)) {
      const message = asString(body.error.message);
      if (message) return message;
    }
  } catch {
    // ignore — fall through to the status text
  }
  return response.statusText || `HTTP ${response.status}`;
}

/** Compose a user-facing error line for a non-retriable / exhausted PSI failure. */
function psiHttpError(
  status: number,
  detail: string,
  url: string,
  keyless: boolean,
): string {
  const base = `PageSpeed Insights could not audit ${url} (HTTP ${status}): ${detail}`;
  // 429/403 keyless → the most common fix is to add an API key.
  if (keyless && (status === 429 || status === 403)) {
    return `${base}. Set PAGESPEED_API_KEY for higher rate limits.`;
  }
  return base;
}

/** Fetch + parse the PSI JSON with retry/backoff on 429 / 5xx / network errors. */
async function fetchPsi(
  requestUrl: string,
  url: string,
  keyless: boolean,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= PSI_MAX_ATTEMPTS; attempt += 1) {
    const timeout = AbortSignal.timeout(PSI_REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(requestUrl, {
        signal: combined,
        headers: { accept: "application/json" },
      });
    } catch (err) {
      // User cancel: propagate so the queue treats it as a cancellation
      // (its `signal?.aborted` guard recognises it), never a recorded failure.
      if (signal?.aborted) throw err;
      // Timeout or network error → retry (with backoff) until attempts run out.
      lastError = new Error(
        `PageSpeed Insights request failed for ${url}: ${
          timeout.aborted
            ? `timed out after ${PSI_REQUEST_TIMEOUT_MS / 1000}s`
            : err instanceof Error
              ? err.message
              : String(err)
        }`,
      );
      if (attempt < PSI_MAX_ATTEMPTS) {
        await delay(PSI_RETRY_BASE_MS * 2 ** (attempt - 1), signal);
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      return (await response.json()) as Record<string, unknown>;
    }

    const detail = await readErrorMessage(response);
    const retriable = response.status === 429 || response.status >= 500;
    if (retriable && attempt < PSI_MAX_ATTEMPTS) {
      lastError = new Error(psiHttpError(response.status, detail, url, keyless));
      await delay(PSI_RETRY_BASE_MS * 2 ** (attempt - 1), signal);
      continue;
    }
    throw new Error(psiHttpError(response.status, detail, url, keyless));
  }

  // Unreachable in practice (the loop always returns or throws), but satisfies
  // the type checker and guards against a future off-by-one.
  throw lastError ?? new Error(`PageSpeed Insights failed for ${url}.`);
}

/** One completed PSI analysis: the raw LHR, its parsed projection, CrUX field
 * data, and a resolved fetch time. `selectMedianRun` keys on `lhr`. */
interface PsiRun {
  lhr: LighthouseResult;
  parsed: ReturnType<typeof parseLhr>;
  field: ReturnType<typeof parseFieldData>;
  fetchTime: string;
}

/**
 * Run a SINGLE PageSpeed Insights analysis for `url` (one API call). Resolves
 * with the parsed run, or rejects with a descriptive `Error`. Honours an
 * {@link AbortSignal} for user cancellation.
 */
async function runPsiOnce(
  url: string,
  options: AuditOptions,
  signal?: AbortSignal,
): Promise<PsiRun> {
  const apiKey = getPsiApiKey();
  const requestUrl = buildPsiUrl(url, options, apiKey);
  const json = await fetchPsi(requestUrl, url, apiKey === undefined, signal);

  const lhr = (isRecord(json.lighthouseResult)
    ? json.lighthouseResult
    : {}) as LighthouseResult;

  // PSI returns an LHR even when the page failed to load, with the reason in
  // `lhr.runtimeError` — treat that as an error rather than reporting 0 scores.
  const runtimeError = runtimeErrorMessage(lhr);
  if (runtimeError !== null) {
    throw new Error(`${runtimeError} (${url})`);
  }

  const parsed = parseLhr(lhr, options.formFactor);
  const field = parseFieldData(
    json.loadingExperience,
    json.originLoadingExperience,
  );
  const fetchTime =
    parsed.fetchTime ||
    asString(json.analysisUTCTimestamp) ||
    new Date().toISOString();

  return { lhr, parsed, field, fetchTime };
}

/**
 * Run a PageSpeed Insights audit for `url` with validated `options`: median-of-N
 * over `options.runs` PSI calls. Resolves with an {@link AuditResult}
 * (`source: "psi"`), or rejects with a descriptive `Error`. Honours an
 * {@link AbortSignal} for user cancellation.
 */
export async function runPsiAudit(
  url: string,
  options: AuditOptions,
  signal?: AbortSignal,
): Promise<AuditResult> {
  // Sequential by design — one PSI API call per run (quota = runs × URLs).
  // Running a URL's calls one-at-a-time avoids PSI's short per-URL result cache
  // and rate-limit bursts; cross-URL parallelism is the queue's concurrency knob.
  // No partial-success: if any run throws we let it propagate and fail the whole
  // job (parity with the local engine). Transient 429/5xx are already absorbed by
  // `fetchPsi`'s retry/backoff, so a hard failure is a persistent problem.
  const runs: PsiRun[] = [];
  for (let i = 0; i < options.runs; i += 1) {
    runs.push(await runPsiOnce(url, options, signal));
  }

  // Each run is already parsed, so the median run carries its own projection and
  // CrUX field data (which is a real-user aggregate — identical across calls).
  const median = selectMedianRun(runs);
  const { parsed } = median;

  return {
    requestedUrl: parsed.requestedUrl || url,
    finalUrl: parsed.finalUrl || url,
    options,
    runs: runs.length,
    median: {
      scores: parsed.scores,
      metrics: parsed.metrics,
      opportunities: parsed.opportunities,
      bestPractices: parsed.bestPractices,
      lhr: median.lhr,
    },
    perRunScores: runs.map((run) => run.parsed.scores),
    perRunEnvironments: runs.map((run) => run.parsed.environment),
    fetchTime: median.fetchTime,
    lighthouseVersion: parsed.lighthouseVersion,
    runWarnings: Array.from(new Set(runs.flatMap((run) => run.parsed.runWarnings))),
    environment: parsed.environment,
    source: "psi",
    field: median.field,
  };
}
