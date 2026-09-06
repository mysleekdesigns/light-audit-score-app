/**
 * Pure view logic for the loading filmstrip (ROADMAP Phase D).
 *
 * Vitest runs `environment: "node"` in this repo — there is no DOM and no
 * testing-library — so everything the filmstrip can get *wrong* lives here and
 * `src/components/audit/loading-filmstrip.tsx` stays presentation only. What can
 * go wrong is arithmetic and wording:
 *
 * - **Arithmetic.** `FilmstripData.timelineMs` is `number | null`, and it is `0`
 *   for a report whose only frame sits at navigation start. `timing / timeline`
 *   then yields `Infinity` or `NaN`, and `left: NaN%` is a value CSS drops
 *   *silently* — every frame would stack on the left edge with no error anywhere.
 * - **Wording.** Two different empty states make two different claims (the audit
 *   is absent vs. the audit ran and captured nothing), and the LCP mark must not
 *   be rendered at all when there is no LCP to mark.
 *
 * Nothing here imports React, the DOM, or the extractors — only the frozen
 * contract in `./types`.
 */

import type { FilmstripData } from "@/lib/reports/types";

/** One second, in the milliseconds every timing in `FilmstripData` is measured in. */
const SECOND_MS = 1000;

/**
 * Which of the three things the strip has to say. `unavailable` and `empty` are
 * different *claims*, not two flavours of the same error — see `buildFilmstripView`.
 */
export type FilmstripState = "ready" | "empty" | "unavailable";

/** One frame, resolved to exactly what the component renders — no arithmetic left. */
export interface FilmstripFrameView {
  /** Stable React key. Ordinal-prefixed, so frames sharing a timing don't collide. */
  key: string;
  /** The inline `data:image/jpeg;base64,…` URI, passed straight to `<img src>`. */
  src: string;
  /** 1-based position in capture order, for "frame 3 of 8". */
  ordinal: number;
  /** Monospace readout of `timingMs` (`750 ms`, `1.2 s`). */
  timeLabel: string;
  /** The `<img alt>` — the capture time, which is the meaningful thing about a frame. */
  alt: string;
  /** 0–100: where this capture falls on the strip's time axis. Never `NaN`. */
  positionPct: number;
  /** True for the frame Lighthouse's LCP timing lands on. */
  isLcp: boolean;
}

/** Everything `LoadingFilmstrip` needs, derived once from one `FilmstripData`. */
export interface FilmstripView {
  state: FilmstripState;
  frames: FilmstripFrameView[];
  /** How many frames — read straight off `frames`, so the header can't disagree. */
  frameCount: number;
  /** Monospace LCP readout (`2.4 s`); `null` when the report carried no LCP. */
  lcpLabel: string | null;
  /** 0–100 for the LCP tick on the time axis; `null` when it cannot be placed honestly. */
  lcpPositionPct: number | null;
  /** Ordinal of the frame marked `isLcp`; `null` when no frame is. */
  lcpFrameOrdinal: number | null;
  /** Monospace readout of the strip's extent (`3.2 s`); `null` when unknown. */
  timelineLabel: string | null;
}

/** Two decimals is finer than any pixel at this width, and keeps style strings short. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Format a timing for the monospace readouts: milliseconds below a second, then
 * one decimal of seconds. Rounding happens *before* the threshold test, so
 * `999.6` reads `1.0 s` rather than the self-contradicting `1000 ms`.
 *
 * A non-finite timing prints the em dash the rest of the app uses for "not
 * recorded". A negative one is printed as recorded rather than clamped — this
 * function reports what the trace said; it is `framePositionPercent` that has to
 * keep the strip's geometry inside its rail.
 */
export function formatFrameTime(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const rounded = Math.round(ms);
  if (Math.abs(rounded) < SECOND_MS) return `${rounded} ms`;
  return `${(ms / SECOND_MS).toFixed(1)} s`;
}

/**
 * Where a frame captured at `timingMs` sits on a `0…timelineMs` axis, as a
 * percentage clamped to 0–100.
 *
 * Returns `0` — never `NaN`, never `Infinity` — for every degenerate axis: a
 * `null` timeline (no frames), a `0` timeline (a single frame at navigation
 * start, or every frame sharing one timing), or a non-finite input. A `NaN`
 * would reach CSS as `left: NaN%`, which is discarded without an error and
 * silently piles every frame on the left edge.
 */
export function framePositionPercent(
  timingMs: number,
  timelineMs: number | null,
): number {
  if (timelineMs === null || !Number.isFinite(timelineMs) || timelineMs <= 0) {
    return 0;
  }
  if (!Number.isFinite(timingMs) || timingMs <= 0) return 0;
  if (timingMs >= timelineMs) return 100;
  return round2((timingMs / timelineMs) * 100);
}

/**
 * Where the LCP tick belongs on the same axis, or `null` when it cannot be
 * placed truthfully.
 *
 * Unlike a frame, the LCP is *not* clamped: an LCP later than the last captured
 * frame has no position on this axis, and pinning it to the right-hand edge
 * would claim it coincided with the final frame. The value itself is still shown
 * in text (`lcpLabel`) — only the tick is withheld.
 */
export function lcpMarkerPercent(
  lcpMs: number | null,
  timelineMs: number | null,
): number | null {
  if (lcpMs === null || !Number.isFinite(lcpMs) || lcpMs < 0) return null;
  if (timelineMs === null || !Number.isFinite(timelineMs) || timelineMs <= 0) {
    return null;
  }
  if (lcpMs > timelineMs) return null;
  return round2((lcpMs / timelineMs) * 100);
}

/**
 * The `<img alt>` for one frame. The capture time is what a frame *means*, so
 * that is what the alt says; "screenshot" repeated eight times is not alt text.
 *
 * This string is also the accessible name of the button wrapping the frame — the
 * visible time label and the `LCP` badge are `aria-hidden` duplicates of it — so
 * it carries the LCP fact too. That is what keeps the LCP mark from being
 * conveyed by colour (or by a purely visual badge) alone.
 */
export function frameAltText(frame: {
  timingMs: number;
  ordinal: number;
  total: number;
  isLcp: boolean;
}): string {
  const base = `Page as rendered at ${formatFrameTime(frame.timingMs)}, frame ${frame.ordinal} of ${frame.total}`;
  return frame.isLcp ? `${base}, largest contentful paint` : base;
}

/**
 * Resolve one `FilmstripData` into everything the component renders.
 *
 * Built in a single pass and memoised by the caller, because this array *is*
 * what React maps over — deriving it per render would rebuild eight objects and
 * eight alt strings on every parent update.
 *
 * On the two empty states: `unavailable` means the stored report carried no
 * usable `screenshot-thumbnails` audit (it predates the feature, or Performance
 * was not in scope) — a statement about the *report*. `empty` means the audit is
 * there and recorded no frames — a statement about the *page*. Frames win over
 * the flag if a caller ever supplies both, so real frames can never be hidden by
 * a stale `unavailable`.
 */
export function buildFilmstripView(data: FilmstripData): FilmstripView {
  const total = data.frames.length;
  let lcpFrameOrdinal: number | null = null;

  const frames: FilmstripFrameView[] = data.frames.map((frame, index) => {
    const ordinal = index + 1;
    if (frame.isLcp && lcpFrameOrdinal === null) lcpFrameOrdinal = ordinal;
    return {
      key: `${ordinal}:${frame.timingMs}`,
      src: frame.data,
      ordinal,
      timeLabel: formatFrameTime(frame.timingMs),
      alt: frameAltText({
        timingMs: frame.timingMs,
        ordinal,
        total,
        isLcp: frame.isLcp,
      }),
      positionPct: framePositionPercent(frame.timingMs, data.timelineMs),
      isLcp: frame.isLcp,
    };
  });

  const state: FilmstripState =
    total > 0 ? "ready" : data.unavailable ? "unavailable" : "empty";

  return {
    state,
    frames,
    frameCount: total,
    lcpLabel:
      data.lcpMs !== null && Number.isFinite(data.lcpMs)
        ? formatFrameTime(data.lcpMs)
        : null,
    lcpPositionPct: lcpMarkerPercent(data.lcpMs, data.timelineMs),
    lcpFrameOrdinal,
    timelineLabel:
      data.timelineMs !== null && Number.isFinite(data.timelineMs)
        ? formatFrameTime(data.timelineMs)
        : null,
  };
}
