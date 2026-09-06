/**
 * Presentation helpers for regression alerts (ROADMAP Phase C).
 *
 * `ScheduleAlert` is deliberately free of display strings so a stored row never
 * goes stale against a copy change (see `src/lib/alerts/types.ts`). That leaves
 * exactly one place where a score change turns into English — here — and it is
 * shared by the webhook body and the in-app Archive strip on purpose: an alert a
 * user reads in Slack at 03:05 and then opens in the app at 09:00 must be
 * recognisably the same sentence, or they will spend the difference wondering
 * whether they are looking at two events.
 *
 * Pure and free of React/DOM imports (the same reason `src/lib/schedules/format.ts`
 * is), so both the server-side delivery path and a client component can call it.
 */

import type { AlertKind, ScheduleAlert } from "@/lib/alerts/types";
import { CATEGORY_LABELS } from "@/lib/scores";

/**
 * Human name for an alert kind — the badge text in the UI and the lead-in on a
 * webhook line.
 *
 * "Recovered" rather than "Recovered above": the bar is already spelled out
 * beside it wherever this appears, and the badge has to fit in a table cell.
 */
export function alertKindLabel(kind: AlertKind): string {
  switch (kind) {
    case "crossed_below":
      return "Crossed below";
    case "recovered_above":
      return "Recovered";
    case "dropped_by":
      return "Dropped";
  }
}

/**
 * A signed point change: `-23`, `+8`.
 *
 * The explicit `+` is the point of the function — an unsigned `8` beside a `-23`
 * reads as a magnitude rather than a direction, and the whole value of a
 * recovery line is that it is visibly the other way round. Plain ASCII `+`/`-`
 * (not U+2212) so the string survives a webhook body, a CSV export and a
 * terminal unchanged. Non-finite input degrades to `0` rather than printing
 * `NaN` at someone.
 */
export function formatDelta(delta: number): string {
  if (typeof delta !== "number" || !Number.isFinite(delta)) return "0";
  const rounded = Math.round(delta);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

/**
 * One alert as a single self-contained clause: `Performance 94 → 71 (-23)`.
 *
 * Carries the category, both scores and the signed delta — and deliberately
 * *not* the URL, the form factor or the kind. Those are the axes a caller groups
 * by (a Slack line prefixes the kind and URL, the Archive strip puts the URL in
 * its own column), so repeating them here would print each of them twice in
 * every consumer.
 */
export function alertSummary(alert: ScheduleAlert): string {
  const label = CATEGORY_LABELS[alert.category] ?? alert.category;
  return `${label} ${alert.previous} → ${alert.current} (${formatDelta(alert.delta)})`;
}
