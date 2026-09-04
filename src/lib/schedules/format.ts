/**
 * Presentation helpers for schedule cadence readouts.
 *
 * Shared by the Scheduled archive's `ScheduleCard` and the Edit-schedule
 * dialog so a schedule's next fire reads identically wherever it appears — the
 * dialog's "this is what Next run becomes" preview has to match the card the
 * user is looking at, character for character, or the preview is not a preview.
 *
 * `describeTarget` lives here for the same reason: the card, its title
 * fallback, and the dialog's placeholder must agree on what a schedule is
 * called, and they drifted the moment there were two copies of it.
 *
 * All three are pure and free of React/DB imports, so they unit-test directly. They
 * format in the *viewer's* locale and timezone on purpose: schedules fire at a
 * server-local HH:MM, and this app only ever runs on the user's own machine, so
 * the two are the same clock. Callers must only invoke them client-side (both
 * consumers do, off `useMinuteTick`), since a server render would format against
 * a different locale and break hydration.
 */

import type { ScheduleTarget } from "@/lib/schedules/types";

/** A schedule target reduced to what the UI shows about it. */
export interface DescribedTarget {
  /**
   * What the target *is*, scheme stripped: the first URL plus a `+N more`
   * suffix for a list, or the crawl root. This is the card's title for an
   * unnamed schedule, so it carries the size of a URL list itself.
   */
  label: string;
  /** Target kind, for the chip beside the title. */
  kind: "URLs" | "Crawl";
  /**
   * What {@link label} does not already say, or `""` when there is nothing to
   * add — which is always, for a URL list, whose `+N more` suffix already
   * counts it. A second line reading `18 URLs` under a title ending in
   * `+17 more` said the same thing twice, so URL targets have no detail at all
   * and a crawl's bounds are the only detail there is.
   */
  detail: string;
}

/** Human label for a schedule's target — strips scheme and adds a kind chip. */
export function describeTarget(target: ScheduleTarget): DescribedTarget {
  if (target.kind === "urls") {
    const more = target.urls.length - 1;
    const first = (target.urls[0] ?? "").replace(/^https?:\/\//, "");
    return {
      label: more > 0 ? `${first} +${more} more` : first,
      kind: "URLs",
      detail: "",
    };
  }
  return {
    label: target.spec.url.replace(/^https?:\/\//, ""),
    kind: "Crawl",
    detail: `depth ${target.spec.maxDepth} · ≤${target.spec.maxPages} pages`,
  };
}

/** Format an ISO timestamp into a readable local datetime; falls back to "—". */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Compact relative-ish "in 4h 12m" / "in 2d 3h" label for a future Date. */
export function formatCountdown(then: Date, now: Date): string {
  const diffMs = then.getTime() - now.getTime();
  if (diffMs <= 0) return "due";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}
