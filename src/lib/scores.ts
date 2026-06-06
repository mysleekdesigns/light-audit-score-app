/**
 * Pure score/metric presentation helpers (PRD §6 Phase 3).
 *
 * The single source of truth for how Lighthouse scores and Core Web Vitals are
 * *displayed*: the 0–49 / 50–89 / 90–100 colour bands (PRD Phase 3), the score
 * token class names, and human labels for categories and metrics. Kept free of
 * React/runtime imports so it can be unit-tested and shared by every UI piece
 * (score rings, per-URL cards, the detail sheet).
 */

import type { LighthouseCategory, MetricId } from "@/lib/lighthouse/types";

/** Colour band for a 0–100 Lighthouse score. `none` = unscored / missing. */
export type ScoreBand = "good" | "average" | "poor" | "none";

/** Lower bound (inclusive) of the "good" (green) band. */
export const GOOD_THRESHOLD = 90;
/** Lower bound (inclusive) of the "average" (orange) band. */
export const AVERAGE_THRESHOLD = 50;

/**
 * Map a 0–100 score to its colour band (PRD Phase 3 thresholds):
 * 90–100 good (green), 50–89 average (orange), 0–49 poor (red), null → none.
 */
export function scoreBand(score: number | null | undefined): ScoreBand {
  if (score === null || score === undefined || Number.isNaN(score)) return "none";
  if (score >= GOOD_THRESHOLD) return "good";
  if (score >= AVERAGE_THRESHOLD) return "average";
  return "poor";
}

/** Tailwind text-colour class for a band — drives `currentColor` SVG strokes too. */
export function scoreTextClass(band: ScoreBand): string {
  switch (band) {
    case "good":
      return "text-score-good";
    case "average":
      return "text-score-average";
    case "poor":
      return "text-score-poor";
    case "none":
      return "text-muted-foreground";
  }
}

/** Convenience: text-colour class straight from a numeric score. */
export function scoreColorClass(score: number | null | undefined): string {
  return scoreTextClass(scoreBand(score));
}

/**
 * Tailwind classes for a colour-banded *chip* (the dense {@link ScorePill} and
 * any small banded surface): the band text colour plus a faint tinted fill and
 * hairline border. Shares the same band → token mapping as the rings, so pills
 * and rings can never drift apart (PRD §6 Phase 11). Pairs with {@link scoreBand}.
 */
export function scoreBandChipClass(band: ScoreBand): string {
  switch (band) {
    case "good":
      return "text-score-good bg-score-good/10 border-score-good/30";
    case "average":
      return "text-score-average bg-score-average/10 border-score-average/30";
    case "poor":
      return "text-score-poor bg-score-poor/10 border-score-poor/30";
    case "none":
      return "text-muted-foreground bg-muted/40 border-border/60";
  }
}

/** Convenience: chip classes straight from a numeric score. */
export function scoreChipClass(score: number | null | undefined): string {
  return scoreBandChipClass(scoreBand(score));
}

/**
 * A solid band fill (no tint), for legend swatches and dense indicators where a
 * full-strength colour reads better than the chip's faint fill. Same band → token
 * source of truth as every other score surface.
 */
export function scoreBandSolidClass(band: ScoreBand): string {
  switch (band) {
    case "good":
      return "bg-score-good";
    case "average":
      return "bg-score-average";
    case "poor":
      return "bg-score-poor";
    case "none":
      return "bg-muted-foreground";
  }
}

/** Format a 0–100 score for display: rounded integer, or an em dash when unscored. */
export function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined || Number.isNaN(score)) return "—";
  return String(Math.round(score));
}

/** Human label for each Lighthouse category. */
export const CATEGORY_LABELS: Record<LighthouseCategory, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  "best-practices": "Best Practices",
  seo: "SEO",
};

/** Short label (for compact ring captions). */
export const CATEGORY_SHORT_LABELS: Record<LighthouseCategory, string> = {
  performance: "Perf",
  accessibility: "A11y",
  "best-practices": "BP",
  seo: "SEO",
};

/**
 * Display metadata for each Core Web Vital / key timing metric. `abbr` is the
 * canonical Lighthouse abbreviation; order here is the PRD's display order
 * (LCP, CLS, TBT, FCP, SI, TTI).
 */
export const METRIC_META: Record<MetricId, { label: string; abbr: string }> = {
  "largest-contentful-paint": { label: "Largest Contentful Paint", abbr: "LCP" },
  "cumulative-layout-shift": { label: "Cumulative Layout Shift", abbr: "CLS" },
  "total-blocking-time": { label: "Total Blocking Time", abbr: "TBT" },
  "first-contentful-paint": { label: "First Contentful Paint", abbr: "FCP" },
  "speed-index": { label: "Speed Index", abbr: "SI" },
  interactive: { label: "Time to Interactive", abbr: "TTI" },
};

/** PRD display order for the Core Web Vitals strip. */
export const METRIC_DISPLAY_ORDER: readonly MetricId[] = [
  "largest-contentful-paint",
  "cumulative-layout-shift",
  "total-blocking-time",
  "first-contentful-paint",
  "speed-index",
  "interactive",
] as const;
