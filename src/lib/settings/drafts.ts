/**
 * Audit form drafts — the shared contract for keeping what the user has typed
 * (URL list, active targets tab, discovered pages + their selection, the
 * PageSpeed form's dials) alive across in-app navigation and a page reload.
 *
 * The audit itself keeps running server-side whatever the browser does; these
 * drafts make the console *look* untouched when the user comes back to it. The
 * store is the browser hook {@link file://../../hooks/useAuditDraft.ts}
 * (`sessionStorage` — per tab, gone when the tab closes, which is the right
 * lifetime for a draft). This module owns the pure, runtime-free shapes, their
 * empty values, and the normalisers that turn an untrusted blob back into a
 * valid draft (every field whitelisted/clamped, never throwing). Kept free of
 * React / DOM imports so it is trivially unit-testable and safe to import from
 * anywhere.
 *
 * The local Lighthouse form only drafts its *targets*: its run-config dials are
 * already remembered on every change through {@link AuditDefaults}. The
 * PageSpeed form's dials have no such home, so its draft carries them too.
 */

import type { DiscoveredUrl, DiscoverResult } from "@/lib/crawl/types";
import {
  type DeviceSelection,
  type LighthouseCategory,
  LIGHTHOUSE_CATEGORIES,
  MAX_RUNS,
  MIN_RUNS,
} from "@/lib/lighthouse/types";
import { clampConcurrency, DEFAULT_CONCURRENCY } from "@/lib/queue/types";
import { sanitizeCategories } from "@/lib/settings/defaults";

/** Which targets input is active: the pasted URL list or the site crawl. */
export type TargetsTab = "paste" | "crawl";

/**
 * The user's last workspace intent (Discover → the curation table, Run → the
 * live results). `null` until they act; the form resolves it against whether a
 * batch exists.
 */
export type WorkspaceIntent = "discovered" | "results" | null;

/** A discovery result plus the URLs the user has left checked. */
export interface CrawlDraft {
  result: DiscoverResult;
  /** Selected URLs (a subset of `result.urls`); order is irrelevant. */
  selected: string[];
}

/** What both audit forms draft: the targets half of the instrument. */
export interface TargetsDraft {
  tab: TargetsTab;
  /** Raw contents of the paste-list textarea. */
  text: string;
  crawl: CrawlDraft | null;
  workspaceView: WorkspaceIntent;
}

/** The PageSpeed form's draft: targets plus its (otherwise unremembered) dials. */
export interface PsiFormDraft extends TargetsDraft {
  device: DeviceSelection;
  /** Non-empty, canonical order. */
  categories: LighthouseCategory[];
  /** A PSI report locale code, or {@link PSI_LOCALE_DEFAULT} for no override. */
  locale: string;
  /** Median-of-N runs (MIN_RUNS..MAX_RUNS); each run is one PSI API call. */
  runs: number;
  /** Parallel URLs (clamped to the queue's band). */
  concurrency: number;
}

/** Sentinel `<Select>` value for "no locale override" (PSI's own default). */
export const PSI_LOCALE_DEFAULT = "default";

/** A pristine targets draft — also the SSR snapshot, so it must never change shape. */
export const EMPTY_TARGETS_DRAFT: TargetsDraft = {
  tab: "paste",
  text: "",
  crawl: null,
  workspaceView: null,
};

/** A pristine PageSpeed draft: mobile / all categories / default locale / 3 runs. */
export const EMPTY_PSI_FORM_DRAFT: PsiFormDraft = {
  ...EMPTY_TARGETS_DRAFT,
  device: "mobile",
  categories: [...LIGHTHOUSE_CATEGORIES],
  locale: PSI_LOCALE_DEFAULT,
  runs: 3,
  concurrency: DEFAULT_CONCURRENCY,
};

/**
 * `sessionStorage` keys, versioned so a future shape change can migrate or
 * simply ignore stale blobs rather than mis-read them.
 */
export const LOCAL_DRAFT_STORAGE_KEY = "lighthouse:audit-draft:local:v1";
export const PSI_DRAFT_STORAGE_KEY = "lighthouse:audit-draft:psi:v1";

/** Accepts `en`, `en_US`, `pt_BR`, `zh` … — the shape of a PSI locale code. */
const LOCALE_PATTERN = /^[a-z]{2,3}(?:_[A-Za-z]{2,4})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Clamp a stored runs value into [MIN_RUNS, MAX_RUNS]; anything unusable → 3. */
function clampRuns(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return EMPTY_PSI_FORM_DRAFT.runs;
  return Math.min(MAX_RUNS, Math.max(MIN_RUNS, Math.floor(value)));
}

/** One discovered URL, or `null` if the entry is not usable. */
function sanitizeDiscoveredUrl(value: unknown): DiscoveredUrl | null {
  if (!isRecord(value)) return null;
  if (typeof value.url !== "string" || value.url === "") return null;
  if (value.source !== "sitemap" && value.source !== "crawl") return null;
  const url: DiscoveredUrl = { url: value.url, source: value.source };
  if (typeof value.depth === "number" && Number.isFinite(value.depth)) {
    url.depth = value.depth;
  }
  return url;
}

/**
 * Rebuild a {@link CrawlDraft} from an untrusted value: unusable entries are
 * dropped, duplicates collapsed, and the selection is intersected with the
 * surviving URLs so it can never reference a page that isn't in the table.
 * Returns `null` when there is no coherent result to restore.
 */
export function sanitizeCrawlDraft(value: unknown): CrawlDraft | null {
  if (!isRecord(value) || !isRecord(value.result)) return null;
  const result = value.result;
  if (typeof result.origin !== "string" || !Array.isArray(result.urls)) return null;

  const seen = new Set<string>();
  const urls: DiscoveredUrl[] = [];
  for (const entry of result.urls) {
    const url = sanitizeDiscoveredUrl(entry);
    if (!url || seen.has(url.url)) continue;
    seen.add(url.url);
    urls.push(url);
  }

  const selected = Array.isArray(value.selected)
    ? [...new Set(value.selected.filter((u): u is string => typeof u === "string" && seen.has(u)))]
    : [];

  const totalFound =
    typeof result.totalFound === "number" && Number.isFinite(result.totalFound)
      ? Math.max(urls.length, Math.floor(result.totalFound))
      : urls.length;
  const warnings = Array.isArray(result.warnings)
    ? result.warnings.filter((w): w is string => typeof w === "string")
    : [];

  return {
    result: {
      origin: result.origin,
      urls,
      totalFound,
      robotsBlocked: result.robotsBlocked === true,
      warnings,
    },
    selected,
  };
}

/**
 * Turn an untrusted value (a parsed `sessionStorage` blob) into a valid
 * {@link TargetsDraft}. Unknown or malformed fields degrade to the empty draft's
 * value for that field. Never throws.
 */
export function normalizeTargetsDraft(raw: unknown): TargetsDraft {
  const source = isRecord(raw) ? raw : {};
  return {
    tab: source.tab === "crawl" ? "crawl" : "paste",
    text: typeof source.text === "string" ? source.text : "",
    crawl: sanitizeCrawlDraft(source.crawl),
    workspaceView:
      source.workspaceView === "discovered" || source.workspaceView === "results"
        ? source.workspaceView
        : null,
  };
}

/**
 * {@link normalizeTargetsDraft} plus the PageSpeed dials, each clamped or
 * whitelisted against the engine's own bounds. Never throws.
 */
export function normalizePsiFormDraft(raw: unknown): PsiFormDraft {
  const source = isRecord(raw) ? raw : {};
  return {
    ...normalizeTargetsDraft(source),
    device:
      source.device === "desktop" || source.device === "both" ? source.device : "mobile",
    categories: sanitizeCategories(source.categories),
    locale:
      typeof source.locale === "string" && LOCALE_PATTERN.test(source.locale)
        ? source.locale
        : PSI_LOCALE_DEFAULT,
    runs: clampRuns(source.runs),
    concurrency:
      typeof source.concurrency === "number"
        ? clampConcurrency(source.concurrency)
        : DEFAULT_CONCURRENCY,
  };
}
