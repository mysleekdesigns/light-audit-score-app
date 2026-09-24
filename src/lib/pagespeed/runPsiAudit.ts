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
 * Quota handling. Google enforces a per-project "Queries per minute" quota and
 * answers HTTP 429 the moment it is exceeded. Every request goes through the
 * process-wide {@link getPsiRateLimiter}: it paces calls under the configured
 * per-minute ceiling, and a 429 puts EVERY concurrent job on cooldown (Google's
 * `Retry-After`, else 15s doubling to 60s) so the batch stops feeding an
 * exhausted window. A request gets {@link PSI_QUOTA_MAX_ATTEMPTS} such attempts;
 * only then is it a {@link PsiQuotaError}, and if the job already has completed
 * runs it keeps them (median of fewer runs, flagged in `runWarnings`) instead of
 * discarding Google's finished work.
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
  PSI_QUOTA_MAX_ATTEMPTS,
  PSI_QUOTA_RETRY_BASE_MS,
  PSI_QUOTA_RETRY_MAX_MS,
  PSI_REQUEST_TIMEOUT_MS,
  PSI_RETRY_BASE_MS,
} from "@/lib/pagespeed/config";
import { parseFieldData } from "@/lib/pagespeed/parseFieldData";
import { abortableDelay, getPsiRateLimiter } from "@/lib/pagespeed/rateLimiter";

/**
 * Google answered HTTP 429 to every quota attempt for one request. Distinct from
 * a plain `Error` so {@link runPsiAudit} can keep the runs it already has.
 */
export class PsiQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PsiQuotaError";
  }
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

/**
 * `Retry-After` as milliseconds from now, when Google sends one (delta-seconds or
 * an HTTP-date). Clamped to twice the quota ceiling so a bogus header cannot park
 * a job for an hour; `undefined` when absent or unparseable.
 */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return undefined;
  let ms: number;
  if (/^\d+$/.test(header)) {
    ms = Number.parseInt(header, 10) * 1000;
  } else {
    const at = Date.parse(header);
    if (Number.isNaN(at)) return undefined;
    ms = at - Date.now();
  }
  return Math.min(Math.max(ms, 0), PSI_QUOTA_RETRY_MAX_MS * 2);
}

/** Wait before the next attempt after the n-th consecutive 429 with no
 * `Retry-After`: 15s, 30s, 60s, 60s… — long enough for the minute to roll over. */
function quotaBackoffMs(failures: number): number {
  return Math.min(
    PSI_QUOTA_RETRY_BASE_MS * 2 ** (failures - 1),
    PSI_QUOTA_RETRY_MAX_MS,
  );
}

/** Compose a user-facing error line for a non-retriable / exhausted PSI failure. */
function psiHttpError(
  status: number,
  detail: string,
  url: string,
  keyless: boolean,
): string {
  const base = `PageSpeed Insights could not audit ${url} (HTTP ${status}): ${detail}`;
  // 403 keyless → the most common fix is to add an API key.
  if (keyless && status === 403) {
    return `${base}. Set PAGESPEED_API_KEY for higher rate limits.`;
  }
  return base;
}

/** User-facing line for a 429 that outlasted every quota attempt. */
function psiQuotaExhausted(
  detail: string,
  url: string,
  keyless: boolean,
  attempts: number,
  waitedMs: number,
): string {
  const waited = Math.round(waitedMs / 1000);
  const base =
    `PageSpeed Insights could not audit ${url}: Google's per-minute quota for ` +
    `this API key's project stayed exhausted across ${attempts} attempts over ` +
    `${waited}s (HTTP 429: ${detail}).`;
  if (keyless) {
    return `${base} Set PAGESPEED_API_KEY — keyless requests have no quota.`;
  }
  return (
    `${base} Lower Concurrency or runs per URL, check the project's ` +
    `"Queries per minute" quota in Google Cloud Console (another app may share ` +
    `it), or set PAGESPEED_REQUESTS_PER_MINUTE to pace requests below it.`
  );
}

/**
 * Fetch + parse the PSI JSON through the shared limiter, retrying transient
 * failures (5xx / network, short backoff) and quota rejections (429, long
 * backoff shared with every other job) on separate budgets.
 */
async function fetchPsi(
  requestUrl: string,
  url: string,
  keyless: boolean,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const limiter = getPsiRateLimiter();
  let transientFailures = 0;
  let quotaFailures = 0;
  let quotaWaitedMs = 0;

  for (;;) {
    // Shared pacing, plus any cooldown a 429 (ours or another job's) put in place.
    await limiter.acquire(signal);

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
      transientFailures += 1;
      const error = new Error(
        `PageSpeed Insights request failed for ${url}: ${
          timeout.aborted
            ? `timed out after ${PSI_REQUEST_TIMEOUT_MS / 1000}s`
            : err instanceof Error
              ? err.message
              : String(err)
        }`,
      );
      if (transientFailures >= PSI_MAX_ATTEMPTS) throw error;
      await abortableDelay(
        PSI_RETRY_BASE_MS * 2 ** (transientFailures - 1),
        signal,
      );
      continue;
    }

    if (response.ok) {
      return (await response.json()) as Record<string, unknown>;
    }

    const detail = await readErrorMessage(response);

    if (response.status === 429) {
      // Google's per-minute quota. A 1–2s wait cannot help — the window has to
      // roll over — so wait `Retry-After` or 15s+, and pause EVERY job through
      // the shared limiter so the others stop feeding the exhausted window and
      // retrying in lockstep against it. `acquire()` above waits the cooldown out.
      quotaFailures += 1;
      const wait = Math.max(
        retryAfterMs(response) ?? quotaBackoffMs(quotaFailures),
        1_000,
      );
      limiter.cooldown(wait);
      if (quotaFailures >= PSI_QUOTA_MAX_ATTEMPTS) {
        throw new PsiQuotaError(
          psiQuotaExhausted(detail, url, keyless, quotaFailures, quotaWaitedMs),
        );
      }
      quotaWaitedMs += wait;
      continue;
    }

    if (response.status >= 500) {
      transientFailures += 1;
      if (transientFailures >= PSI_MAX_ATTEMPTS) {
        throw new Error(psiHttpError(response.status, detail, url, keyless));
      }
      await abortableDelay(
        Math.max(
          PSI_RETRY_BASE_MS * 2 ** (transientFailures - 1),
          retryAfterMs(response) ?? 0,
        ),
        signal,
      );
      continue;
    }

    throw new Error(psiHttpError(response.status, detail, url, keyless));
  }
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
  const runs: PsiRun[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < options.runs; i += 1) {
    try {
      runs.push(await runPsiOnce(url, options, signal));
    } catch (err) {
      // A quota rejection AFTER at least one run completed: keep what we have
      // (median of fewer runs, flagged in `runWarnings`) rather than throw away
      // Google's finished work. Zero completed runs, and every other failure
      // (page runtimeError, 4xx, exhausted transient retries), still fail the
      // whole job — parity with the local engine.
      if (err instanceof PsiQuotaError && runs.length > 0) {
        warnings.push(
          `PageSpeed Insights completed ${runs.length} of ${options.runs} runs ` +
            `for this page: Google's per-minute quota stayed exhausted on run ` +
            `${i + 1}, so the scores are the median of the completed runs.`,
        );
        break;
      }
      throw err;
    }
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
    runWarnings: Array.from(
      new Set([...runs.flatMap((run) => run.parsed.runWarnings), ...warnings]),
    ),
    environment: parsed.environment,
    source: "psi",
    field: median.field,
  };
}
