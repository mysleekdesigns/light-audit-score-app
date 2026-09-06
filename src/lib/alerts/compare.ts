/**
 * The pure comparison core for regression alerts (ROADMAP Phase C).
 *
 * Phase 14 built a scheduler that runs a batch every day and told nobody what
 * changed. This module is the half that closes the loop *without* any I/O: give
 * it the median scores of a schedule's newest fire and of the one before it, plus
 * the schedule's {@link ScheduleNotify} preferences, and it returns the typed
 * {@link ScheduleAlert}s worth telling a human about.
 *
 * ## Why it is pure
 *
 * Everything interesting about alerting is a judgement call — which drop matters,
 * which rise is a recovery, when a missing score means "no data" rather than
 * "zero". Those calls belong somewhere they can be exhaustively unit-tested with
 * plain literals, not somewhere that needs SQLite, a queue and a fired batch to
 * exercise. The scheduler's job is reduced to fetching two arrays and handing
 * them over; ours is to decide. Keep this file free of DB / queue / fetch
 * imports (the same discipline `src/lib/schedules/cadence.ts` follows).
 *
 * ## Deliberately quiet
 *
 * The single most important property is that a steady site produces **nothing**.
 * A monitor that posts every night is a monitor people mute, and a muted monitor
 * is worse than none because it looks like coverage. So: no event when nothing
 * crosses, at most one event per (url, form factor, category), a rise is only
 * ever reported when it clears a bar the score was previously under, and a
 * missing score is silence rather than a fabricated 0.
 */

import type { ScheduleAlert, ScheduleNotify } from "@/lib/alerts/types";
import { DEFAULT_ALERT_DELTA, MIN_ALERT_DELTA } from "@/lib/alerts/types";
import {
  LIGHTHOUSE_CATEGORIES,
  type CategoryScores,
  type FormFactor,
  type LighthouseCategory,
} from "@/lib/lighthouse/types";

/**
 * One run's identity + median scores, as the comparison sees it.
 *
 * A deliberately thin projection of whatever the persistence layer stores for a
 * finished run: the comparison needs the pairing key and the numbers, and
 * nothing else. Keeping it this small means the SQLite reader can change shape
 * without touching a line of alert logic, and the tests can be written as
 * literals.
 */
export interface AlertRunScore {
  /** The audited URL, exactly as the run recorded it. */
  url: string;
  /** Device the run used — a mobile drop is not a desktop drop. */
  formFactor: FormFactor;
  /** Median category scores for the run. Missing / `null` = unscored. */
  scores: CategoryScores;
}

/**
 * Severity order for the emitted list: what a human should read first.
 *
 * A bar crossing outranks a slide (something that was passing now isn't), and a
 * recovery comes last because it is the only good news in the batch. Encoded as
 * a rank rather than a comparator chain so the sort stays readable.
 */
const KIND_RANK: Record<ScheduleAlert["kind"], number> = {
  crossed_below: 0,
  dropped_by: 1,
  recovered_above: 2,
};

/** Canonical category order, as an index, for the final ordering tie-break. */
const CATEGORY_RANK = new Map<LighthouseCategory, number>(
  LIGHTHOUSE_CATEGORIES.map((category, index) => [category, index]),
);

/**
 * Pairing key for a run. The separator is NUL, which neither a URL nor a form
 * factor can contain, so no two distinct pairs can ever spell the same key.
 */
function pairKey(run: Pick<AlertRunScore, "url" | "formFactor">): string {
  return `${run.url}\u0000${run.formFactor}`;
}

/**
 * A score the comparison is willing to reason about, or `null`.
 *
 * `CategoryScores` is `Partial<Record<..., number | null>>`: a category can be
 * absent (it wasn't selected for that run), explicitly `null` (it ran and
 * produced no score), or `NaN` (a corrupted row). All three mean *no data*, and
 * none of them means zero — treating a failed run as a 0 would fire a
 * `crossed_below` on every category of every flaky night.
 */
function usableScore(scores: CategoryScores, category: LighthouseCategory): number | null {
  const value = scores[category];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Categories to watch, in canonical order and without duplicates.
 *
 * Iterating `LIGHTHOUSE_CATEGORIES` rather than `notify.categories` means the
 * output order is a property of the engine, not of however the config happened
 * to be written — a config listing `["seo", "performance"]` and one listing
 * `["performance", "seo"]` must produce byte-identical alerts.
 */
function watchedCategories(notify: ScheduleNotify): LighthouseCategory[] {
  const selected = new Set(notify.categories ?? []);
  return LIGHTHOUSE_CATEGORIES.filter((category) => selected.has(category));
}

/**
 * The `dropped_by` bar, defensively resolved.
 *
 * `sanitizeNotify` already clamps this to 1–100, but `compareBatches` is called
 * with whatever the caller has and must never throw or, worse, alert on an
 * *unchanged* score: a `minDelta` of 0 would make `prev - cur >= 0` true for
 * every steady category on the site, which is the exact failure mode this module
 * exists to avoid. So a non-number degrades to the factory default and anything
 * below the contract's floor is lifted to it.
 */
function resolveMinDelta(notify: ScheduleNotify): number {
  const raw = notify.minDelta;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_ALERT_DELTA;
  return Math.max(MIN_ALERT_DELTA, raw);
}

/**
 * The pass bar for a category, or `null` when the config has none usable.
 *
 * A missing/garbled bar disables *crossing* detection for that category only —
 * the `dropped_by` rule still applies, so a schedule with a corrupted threshold
 * blob still reports slides instead of going silent.
 */
function resolveThreshold(
  notify: ScheduleNotify,
  category: LighthouseCategory,
): number | null {
  const raw = notify.thresholds?.[category];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * Classify one (url, form factor, category) pair, or return `null` for silence.
 *
 * The rules, in the order they are applied — the order matters, because a bar
 * crossing and a big slide are frequently the same event and it must be reported
 * once, as the crossing:
 *
 *  1. `prev >= t && cur < t`  → `crossed_below`   (carries the bar `t`)
 *  2. `prev < t  && cur >= t` → `recovered_above` (carries the bar `t`)
 *  3. `prev - cur >= minDelta` → `dropped_by`     (bar-independent, `threshold: null`)
 *  4. otherwise → nothing.
 *
 * Note what rule 3 does *not* do: a rise that doesn't clear a bar is never an
 * alert. Nobody needs to be woken up because Performance went from 41 to 63.
 */
function classify(
  url: string,
  formFactor: FormFactor,
  category: LighthouseCategory,
  previous: number,
  current: number,
  threshold: number | null,
  minDelta: number,
): ScheduleAlert | null {
  const delta = current - previous;

  if (threshold !== null) {
    if (previous >= threshold && current < threshold) {
      return {
        kind: "crossed_below",
        url,
        formFactor,
        category,
        previous,
        current,
        delta,
        threshold,
      };
    }
    if (previous < threshold && current >= threshold) {
      return {
        kind: "recovered_above",
        url,
        formFactor,
        category,
        previous,
        current,
        delta,
        threshold,
      };
    }
  }

  if (previous - current >= minDelta) {
    return {
      kind: "dropped_by",
      url,
      formFactor,
      category,
      previous,
      current,
      delta,
      threshold: null,
    };
  }

  return null;
}

/**
 * Compare a schedule's newest fire against its previous one.
 *
 * Pure. Never throws. Returns `[]` when nothing crossed.
 *
 * ### Pairing
 *
 * Runs are paired on `(url, formFactor)`, and **both sides must be present**. A
 * URL that appears in only one of the two fires yields nothing at all: the
 * target list was edited, a crawl discovered a different page set, or a batch
 * was resumed partially — none of which is a score regression, and all of which
 * would otherwise flood the channel the morning after a routine edit. Where a
 * fire somehow contains the same pair twice, the first occurrence wins on each
 * side, so the result stays deterministic.
 *
 * ### Ordering
 *
 * Fully specified, because this list is rendered into a webhook body and an
 * Archive strip that must not reshuffle between reads: severity
 * (`crossed_below` → `dropped_by` → `recovered_above`), then `delta` ascending
 * (biggest drop first), then URL, then form factor, then canonical category
 * order.
 */
export function compareBatches(
  previous: readonly AlertRunScore[],
  current: readonly AlertRunScore[],
  notify: ScheduleNotify,
): ScheduleAlert[] {
  // Master switch: an unarmed schedule never even pairs its runs.
  if (!notify || notify.enabled !== true) return [];

  const categories = watchedCategories(notify);
  if (categories.length === 0) return [];

  const minDelta = resolveMinDelta(notify);
  const thresholds = new Map<LighthouseCategory, number | null>(
    categories.map((category) => [category, resolveThreshold(notify, category)]),
  );

  const priorByPair = new Map<string, AlertRunScore>();
  for (const run of previous ?? []) {
    if (!run) continue;
    const key = pairKey(run);
    // First occurrence wins — a duplicated pair must not flip the result.
    if (!priorByPair.has(key)) priorByPair.set(key, run);
  }

  const alerts: ScheduleAlert[] = [];
  const seenPairs = new Set<string>();

  for (const run of current ?? []) {
    if (!run) continue;
    const key = pairKey(run);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);

    const prior = priorByPair.get(key);
    if (!prior) continue;

    for (const category of categories) {
      const before = usableScore(prior.scores ?? {}, category);
      const after = usableScore(run.scores ?? {}, category);
      // A comparison needs a number on BOTH sides; anything else is silence.
      if (before === null || after === null) continue;

      const alert = classify(
        run.url,
        run.formFactor,
        category,
        before,
        after,
        thresholds.get(category) ?? null,
        minDelta,
      );
      if (alert) alerts.push(alert);
    }
  }

  return alerts.sort(compareAlerts);
}

/** The total order documented on {@link compareBatches}. */
function compareAlerts(a: ScheduleAlert, b: ScheduleAlert): number {
  const bySeverity = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (bySeverity !== 0) return bySeverity;

  const byDelta = a.delta - b.delta;
  if (byDelta !== 0) return byDelta;

  if (a.url !== b.url) return a.url < b.url ? -1 : 1;
  if (a.formFactor !== b.formFactor) return a.formFactor < b.formFactor ? -1 : 1;

  return (
    (CATEGORY_RANK.get(a.category) ?? LIGHTHOUSE_CATEGORIES.length) -
    (CATEGORY_RANK.get(b.category) ?? LIGHTHOUSE_CATEGORIES.length)
  );
}
