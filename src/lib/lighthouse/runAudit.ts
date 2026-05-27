/**
 * Single Lighthouse run + robust teardown (PRD §6 Phase 1).
 *
 * Each run launches a FRESH, ISOLATED Chrome instance with a unique temp
 * `--user-data-dir` (cold cache, `--headless=new`) so runs cannot contaminate
 * one another. Chrome is always killed and the temp dir always removed in a
 * `finally`, even when Lighthouse throws.
 *
 * `parseLhr` is a pure, I/O-free helper exported for unit testing: it narrows
 * the loosely-typed LHR (`Record<string, unknown>`) into our stable contract.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { launch, type LaunchedChrome } from "chrome-launcher";
import lighthouse, {
  desktopConfig,
  type LighthouseFlags,
} from "lighthouse";

import { classifyAuditError, runtimeErrorMessage } from "@/lib/lighthouse/diagnose";
import {
  type CategoryScores,
  type CoreWebVitals,
  type FormFactor,
  type LighthouseCategory,
  type LighthouseResult,
  LIGHTHOUSE_CATEGORIES,
  type MetricId,
  METRIC_IDS,
  type MetricValue,
  type Opportunity,
  type RunSingleAudit,
  type SingleRunResult,
  type Throttling,
} from "@/lib/lighthouse/types";

/** Max opportunities surfaced per run (sorted by estimated savings desc). */
const MAX_OPPORTUNITIES = 15;

/**
 * Per-navigation load ceiling handed to Lighthouse. Bounds a single run so a
 * hung navigation fails fast (and is then classified by `classifyAuditError`)
 * instead of stalling until the 5-minute worker ceiling (`WORKER_TIMEOUT_MS`).
 */
const MAX_WAIT_FOR_LOAD_MS = 45_000;

/** Map our user-facing throttling choice to Lighthouse's `throttlingMethod`. */
function toThrottlingMethod(
  throttling: Throttling,
): NonNullable<LighthouseFlags["throttlingMethod"]> {
  return throttling === "simulated" ? "simulate" : "devtools";
}

// --- LHR narrowing helpers (pure) ------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** First defined string among the given keys on a record. */
function pickString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function getCategories(lhr: LighthouseResult): Record<string, unknown> {
  const categories = lhr.categories;
  return isRecord(categories) ? categories : {};
}

function getAudits(lhr: LighthouseResult): Record<string, unknown> {
  const audits = lhr.audits;
  return isRecord(audits) ? audits : {};
}

/** Normalise Lighthouse category scores (0–1) to 0–100, keyed by category id. */
function parseScores(lhr: LighthouseResult): CategoryScores {
  const categories = getCategories(lhr);
  const scores: CategoryScores = {};
  for (const id of LIGHTHOUSE_CATEGORIES) {
    const category = categories[id];
    if (!isRecord(category)) continue;
    const raw = asNumber(category.score);
    scores[id as LighthouseCategory] = raw === null ? null : Math.round(raw * 100);
  }
  return scores;
}

/** Read each Core Web Vital / key timing audit; null when the audit is absent. */
function parseMetrics(lhr: LighthouseResult): CoreWebVitals {
  const audits = getAudits(lhr);
  const metrics = {} as CoreWebVitals;
  for (const id of METRIC_IDS) {
    const audit = audits[id];
    if (!isRecord(audit)) {
      metrics[id as MetricId] = null;
      continue;
    }
    const value: MetricValue = {
      numericValue: asNumber(audit.numericValue),
      displayValue: asString(audit.displayValue) ?? "",
      score: asNumber(audit.score),
    };
    metrics[id as MetricId] = value;
  }
  return metrics;
}

/**
 * Extract performance opportunities/diagnostics: audits whose `details.type` is
 * `"opportunity"` or that expose `overallSavingsMs`. Sorted by savings desc and
 * capped to {@link MAX_OPPORTUNITIES}.
 */
function parseOpportunities(lhr: LighthouseResult): Opportunity[] {
  const audits = getAudits(lhr);
  const opportunities: Opportunity[] = [];

  for (const [id, rawAudit] of Object.entries(audits)) {
    if (!isRecord(rawAudit)) continue;
    const details = isRecord(rawAudit.details) ? rawAudit.details : undefined;
    const detailsType = details ? asString(details.type) : undefined;
    const overallSavingsMs = details
      ? asNumber(details.overallSavingsMs)
      : null;

    const isOpportunity =
      detailsType === "opportunity" || overallSavingsMs !== null;
    if (!isOpportunity) continue;

    opportunities.push({
      id,
      title: asString(rawAudit.title) ?? id,
      description: asString(rawAudit.description) ?? "",
      savingsMs: overallSavingsMs,
      displayValue: asString(rawAudit.displayValue) ?? "",
      score: asNumber(rawAudit.score),
    });
  }

  opportunities.sort((a, b) => (b.savingsMs ?? 0) - (a.savingsMs ?? 0));
  return opportunities.slice(0, MAX_OPPORTUNITIES);
}

/**
 * Pure transform from a raw LHR into our contract (minus the raw `lhr`).
 * No Chrome, no I/O — unit-testable in isolation. Tolerates field-name variance
 * across Lighthouse versions.
 */
export function parseLhr(
  lhr: LighthouseResult,
  formFactor: FormFactor,
): Omit<SingleRunResult, "lhr"> {
  const requestedUrl =
    pickString(lhr, "requestedUrl", "mainDocumentUrl") ?? "";
  const finalUrl = pickString(lhr, "finalDisplayedUrl", "finalUrl") ?? "";
  const fetchTime = pickString(lhr, "fetchTime") ?? "";
  const lighthouseVersion = pickString(lhr, "lighthouseVersion") ?? "";

  const runWarnings = Array.isArray(lhr.runWarnings)
    ? lhr.runWarnings.filter((w): w is string => typeof w === "string")
    : [];

  return {
    requestedUrl,
    finalUrl,
    fetchTime,
    lighthouseVersion,
    formFactor,
    scores: parseScores(lhr),
    metrics: parseMetrics(lhr),
    opportunities: parseOpportunities(lhr),
    runWarnings,
  };
}

// --- Single run + teardown -------------------------------------------------

/**
 * Run Lighthouse once against `url` with already-validated `options`, using a
 * fresh isolated Chrome. Chrome is always killed and the temp profile always
 * removed, even on error (see the `finally` block).
 */
export const runSingleAudit: RunSingleAudit = async (url, options) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-"));
  let chrome: LaunchedChrome | undefined;

  try {
    // Inner try/catch maps any launch/Lighthouse/network throw onto a friendly,
    // user-facing message via `classifyAuditError`. It NEVER swallows: every
    // path re-throws. Teardown stays in the outer `finally` so it always runs.
    try {
      chrome = await launch({
        userDataDir,
        chromeFlags: ["--headless=new", `--user-data-dir=${userDataDir}`],
      });

      const flags: LighthouseFlags = {
        logLevel: "error",
        output: ["json", "html"],
        port: chrome.port,
        onlyCategories: options.categories,
        formFactor: options.formFactor,
        throttlingMethod: toThrottlingMethod(options.throttling),
        // Bound a single navigation so a hung page fails fast (and is then
        // classified) rather than stalling until the worker timeout.
        maxWaitForLoad: MAX_WAIT_FOR_LOAD_MS,
      };

      // Desktop uses Lighthouse's `desktopConfig` (sets desktop screenEmulation /
      // formFactor); mobile uses the default config (undefined). The
      // throttlingMethod flag is honoured in either case.
      const config: Record<string, unknown> | undefined =
        options.formFactor === "desktop" ? desktopConfig : undefined;

      const result = await lighthouse(url, flags, config);
      if (!result) {
        throw new Error(
          `Lighthouse returned no result for ${url} (formFactor=${options.formFactor}).`,
        );
      }

      const lhr = result.lhr as LighthouseResult;

      // Lighthouse often returns an LHR even when navigation failed, carrying the
      // reason in `lhr.runtimeError`. Treat that as an error (not bogus scores).
      const runtimeError = runtimeErrorMessage(lhr);
      if (runtimeError !== null) {
        throw new Error(runtimeError);
      }

      return { ...parseLhr(lhr, options.formFactor), lhr };
    } catch (error) {
      // Re-throw a friendly, classified message (includes the url for context).
      throw new Error(classifyAuditError(error, url));
    }
  } finally {
    // Always tear down: kill Chrome (guard if launch failed) then remove the
    // temp user-data-dir. Wrapped so a teardown error never masks a run error.
    try {
      chrome?.kill();
    } catch {
      // best-effort; the process may already be gone
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
};
