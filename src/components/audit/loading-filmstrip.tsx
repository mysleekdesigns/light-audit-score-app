"use client";

import { Film, ImageOff } from "lucide-react";
import { useMemo, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  buildFilmstripView,
  type FilmstripFrameView,
  type FilmstripView,
} from "@/lib/reports/filmstrip-view";
import type { FilmstripData } from "@/lib/reports/types";
import { cn } from "@/lib/utils";

/**
 * The loading filmstrip (ROADMAP Phase D) — Lighthouse's `screenshot-thumbnails`
 * frames laid out against the load timeline, with the LCP frame marked.
 *
 * It renders at the top of the run detail sheet's Trace tab, above the request
 * waterfall, in a column that is 672px wide at its narrowest. Two consequences
 * shape the whole component:
 *
 * 1. **Eight 96px thumbnails do not fit.** The strip therefore scrolls inside its
 *    own `overflow-x-auto` box (the same discipline `PerRunSpread` uses for its
 *    wide table) so the sheet body never scrolls sideways.
 * 2. **A 96px thumbnail of a whole page is unreadable.** Clicking one opens it in
 *    a Dialog, which is what makes the strip answer "what did the user actually
 *    see at 1.2s?" rather than just "something was painting".
 *
 * All arithmetic and wording lives in `@/lib/reports/filmstrip-view` — this file
 * is presentation only, because Vitest runs `environment: "node"` here and a
 * component cannot be unit-tested.
 */
export function LoadingFilmstrip({ data }: { data: FilmstripData }) {
  // The frame array IS what React maps over, and each entry carries a built alt
  // string — deriving it per render would rebuild eight objects on every parent
  // update. `data` is a stable fetch result, so this recomputes only on a new run.
  const view = useMemo(() => buildFilmstripView(data), [data]);
  const [enlarged, setEnlarged] = useState<FilmstripFrameView | null>(null);

  if (view.state !== "ready") return <FilmstripEmpty state={view.state} />;

  return (
    <section className="flex shrink-0 flex-col gap-3">
      <FilmstripHeader view={view} />

      <div className="overflow-hidden rounded-md border border-border/60 bg-card">
        <TimeAxis view={view} />
        {/* The rounded box keeps `overflow-hidden` for its corners, so the scroll
            lives on an inner container; nothing is clipped and the sheet body
            never gains a horizontal scrollbar of its own. */}
        <div className="overflow-x-auto overscroll-x-contain">
          <ol className="flex w-max items-start gap-2 p-3">
            {view.frames.map((frame) => (
              <li key={frame.key} className="shrink-0">
                <FrameButton frame={frame} onSelect={setEnlarged} />
              </li>
            ))}
          </ol>
        </div>
      </div>

      <FrameDialog
        frame={enlarged}
        total={view.frameCount}
        onClose={() => setEnlarged(null)}
      />
    </section>
  );
}

/**
 * `Filmstrip · 8 frames · 0 → 3.5 s` with the LCP value in monospace beside it.
 *
 * The LCP appears here as a *number* as well as on the frame as a badge, so the
 * reading "the LCP happened at 2.4s" never depends on spotting a mark on a
 * thumbnail — or on distinguishing its colour.
 */
function FilmstripHeader({ view }: { view: FilmstripView }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
        Filmstrip
      </p>
      <p className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground tabular-nums">
        <span className="text-foreground">{view.frameCount}</span> frames
        {view.timelineLabel !== null ? (
          <> · 0 → <span className="text-foreground">{view.timelineLabel}</span></>
        ) : null}
        {view.lcpLabel !== null ? (
          <>
            {" · "}
            <span className="text-score-good">LCP {view.lcpLabel}</span>
            {view.lcpFrameOrdinal !== null ? (
              <span> · frame {view.lcpFrameOrdinal}</span>
            ) : null}
          </>
        ) : null}
      </p>
    </div>
  );
}

/**
 * The proportional time axis above the strip.
 *
 * The thumbnails below are spaced *evenly* — at 672px, placing 96px frames at
 * their true `timingMs` would overlap them wherever captures cluster, and
 * overlapping screenshots are unreadable. This rail is the other half of that
 * trade: it puts a tick at each frame's real position, so an uneven capture
 * cadence is visible at a glance while every thumbnail stays legible.
 *
 * Decorative, and hidden from assistive tech: every timing it encodes is already
 * text in the header and under each frame.
 */
function TimeAxis({ view }: { view: FilmstripView }) {
  return (
    <div
      aria-hidden
      className="border-b border-border/60 bg-muted/20 px-3 py-2"
    >
      <div className="relative h-3.5">
        <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        {view.frames.map((frame) => (
          <span
            key={frame.key}
            style={{ left: `${frame.positionPct}%` }}
            className="absolute top-1/2 h-1.5 w-px -translate-x-1/2 -translate-y-1/2 bg-muted-foreground/60"
          />
        ))}
        {view.lcpPositionPct !== null ? (
          // Full height plus a diamond head, so the LCP tick is distinguishable
          // from a frame tick by shape and not only by hue.
          <span
            style={{ left: `${view.lcpPositionPct}%` }}
            className="absolute inset-y-0 w-px -translate-x-1/2 bg-score-good"
          >
            <span className="absolute -top-px left-1/2 size-1.5 -translate-x-1/2 rotate-45 bg-score-good" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One frame: the thumbnail, its monospace capture time, and — on the LCP frame —
 * an `LCP` badge.
 *
 * The mark is a **word**, not a tint: the badge reads `LCP`, the header repeats
 * the value, and the `<img alt>` names "largest contentful paint". The green and
 * the inset ring are reinforcement on top of that, never the message.
 *
 * The button takes its accessible name from the alt (the visible time and badge
 * are `aria-hidden` duplicates of it), so a screen reader hears
 * "Page as rendered at 2.4 s, frame 5 of 8, largest contentful paint, button".
 */
function FrameButton({
  frame,
  onSelect,
}: {
  frame: FilmstripFrameView;
  onSelect: (frame: FilmstripFrameView) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(frame)}
      className="group flex w-24 cursor-pointer flex-col gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
    >
      {/* Fixed box + `object-contain`: the frames are mobile-portrait or
          desktop-landscape depending on the run and their intrinsic size is not
          in the report, so the box — not the image — reserves the space. The
          strip cannot shift as frames decode. */}
      <span
        className={cn(
          "relative block h-32 w-24 overflow-hidden rounded-sm border bg-muted/40 transition-colors",
          frame.isLcp
            ? "border-score-good/70 ring-1 ring-score-good/40 ring-inset"
            : "border-border/60 group-hover:border-foreground/30",
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- the frame is an
            inline `data:image/jpeg;base64,…` URI: there is nothing to fetch (so
            nothing to lazy-load either), and next/image would route a base64
            blob through the optimizer. `width`/`height` describe the reserved
            box, not the frame's own pixels, which the report does not record. */}
        <img
          src={frame.src}
          alt={frame.alt}
          width={96}
          height={128}
          decoding="async"
          className="size-full object-contain"
        />
        {frame.isLcp ? (
          <span
            aria-hidden
            className="absolute inset-x-0 bottom-0 bg-background/85 py-px text-center font-mono text-[0.55rem] font-medium uppercase tracking-[0.18em] text-score-good"
          >
            LCP
          </span>
        ) : null}
      </span>
      <span
        aria-hidden
        className={cn(
          "text-center font-mono text-[0.6rem] tabular-nums transition-colors",
          frame.isLcp
            ? "text-score-good"
            : "text-muted-foreground group-hover:text-foreground",
        )}
      >
        {frame.timeLabel}
      </span>
    </button>
  );
}

/**
 * The clicked frame at a readable size. Mounted only while a frame is selected,
 * so the ~33 KB inline JPEG is never decoded a second time until asked for.
 *
 * Radix handles the keyboard contract (Escape closes, focus is trapped and then
 * returned to the thumbnail that opened it) — no browser-native dialog is used
 * anywhere in this component.
 */
function FrameDialog({
  frame,
  total,
  onClose,
}: {
  frame: FilmstripFrameView | null;
  total: number;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={frame !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {frame !== null ? (
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm uppercase tracking-[0.14em] tabular-nums">
              Frame {frame.ordinal} of {total} · {frame.timeLabel}
            </DialogTitle>
            <DialogDescription>
              {frame.isLcp
                ? "The largest contentful paint landed on this frame."
                : "What the page had painted at this point in the load."}
            </DialogDescription>
          </DialogHeader>
          {/* The box is sized first and the frame centred inside it, so the
              dialog does not resize around the image once it decodes — the same
              reason the thumbnails sit in a fixed box, and the only way to
              reserve space for a frame whose real dimensions the report never
              recorded. */}
          <div className="flex h-[55vh] items-center justify-center rounded-sm border border-border/60 bg-muted/40 p-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- same inline
                data: URI as the thumbnail; see FrameButton. */}
            <img
              src={frame.src}
              alt={frame.alt}
              decoding="async"
              className="max-h-full max-w-full object-contain"
            />
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * The two empty states, which make two different claims and must not be
 * collapsed into one "no data" shrug. Neither is an error.
 *
 * `unavailable` is about the *report*: it carries no usable
 * `screenshot-thumbnails` audit, because it predates the feature or the run did
 * not include Performance. `empty` is about the *page*: the audit is present and
 * recorded no frames.
 */
function FilmstripEmpty({ state }: { state: "empty" | "unavailable" }) {
  const unavailable = state === "unavailable";
  return (
    // Same `shrink-0` section shell as the ready state, so the label still names
    // the section and `Empty`'s own `flex-1` resolves against auto height rather
    // than stealing the column space the waterfall below needs.
    <section className="flex shrink-0 flex-col gap-3">
      <p className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
        Filmstrip
      </p>
      <Empty className="border border-border/60 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {unavailable ? <ImageOff /> : <Film />}
          </EmptyMedia>
          <EmptyTitle>
            {unavailable ? "No filmstrip in this report" : "No frames captured"}
          </EmptyTitle>
          <EmptyDescription>
            {unavailable
              ? "This run’s stored report has no screenshot-thumbnails audit — it predates the filmstrip, or the run didn’t include the Performance category."
              : "Lighthouse ran the screenshot audit for this page and recorded no frames, so there is nothing to lay out on the timeline."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
  );
}
