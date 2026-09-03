/**
 * Presentational primitives for the Documentation page (the user manual).
 *
 * The manual borrows the app's own "precision instrument" language rather than
 * inventing a second one: monospace plate numbers and labels, hairline rules,
 * a signal-cyan accent reserved for structure (never for score semantics), and
 * body copy in the UI grotesque. Everything here is pure and server-safe — no
 * `"use client"`, no hooks — so the manual renders as static HTML and only the
 * table of contents ships JavaScript.
 *
 * Nothing here caps its own measure: chapters run the full width of their
 * column, matching the full-bleed density the rest of the app uses on wide
 * screens. The reading rhythm is carried by the type scale and the leading
 * instead.
 */

import Link from "next/link";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ section */

interface DocsSectionProps {
  /** Anchor id — must match the `id` in `DOCS_SECTIONS` so the TOC can find it. */
  id: string;
  /** Monospace plate number, e.g. "03". */
  index: string;
  title: string;
  /** One-line summary under the heading. */
  lede?: string;
  children: React.ReactNode;
}

/**
 * One numbered chapter.
 *
 * The heading self-link is a sibling of the `<h2>`, not a child: nested inside,
 * its label is concatenated into the heading's accessible name, and a manual of
 * twenty chapters is navigated mostly through the headings list. The `<section>`
 * is deliberately left unnamed so it stays a generic grouping — twenty `region`
 * landmarks would bury the two real ones.
 */
export function DocsSection({ id, index, title, lede, children }: DocsSectionProps) {
  return (
    <section id={id} className="group border-t border-border/60 pt-8 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-2.5">
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.32em] text-primary">
          {index}
        </span>
        <div className="flex items-baseline gap-3">
          <h2
            id={`${id}-heading`}
            className="text-pretty text-2xl font-semibold tracking-tight text-foreground md:text-[1.75rem]"
          >
            {title}
          </h2>
          {/* Reveals on hover/focus so the manual stays quiet at rest but every
              chapter is still linkable. Focusable, so it is reachable by keyboard. */}
          <a
            href={`#${id}`}
            aria-label={`Link to “${title}”`}
            className="font-mono text-sm font-normal text-muted-foreground opacity-0 transition-opacity hover:text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 motion-reduce:transition-none"
          >
            #
          </a>
        </div>
        {lede ? (
          <p className="text-pretty text-[0.95rem] leading-relaxed text-muted-foreground">{lede}</p>
        ) : null}
      </div>
      <div className="mt-6 flex flex-col gap-5">{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------------- prose */

/** Body paragraph. */
export function P({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-[0.95rem] leading-[1.75] text-foreground/85", className)}>{children}</p>
  );
}

/** Sub-heading inside a chapter. */
export function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-2 font-mono text-xs uppercase tracking-[0.2em] text-foreground">
      {children}
    </h3>
  );
}

/**
 * Inline literal — a filename, flag, env var, or value the user will type.
 * `translate="no"` because browser auto-translation happily mangles a command.
 */
export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      translate="no"
      className="rounded-[4px] border border-border/70 bg-muted/50 px-1.5 py-0.5 font-mono text-[0.82em] text-foreground"
    >
      {children}
    </code>
  );
}

/** A control the user clicks, styled to read as a UI chip rather than as code. */
export function UiLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[4px] border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[0.78em] uppercase tracking-[0.08em] text-primary">
      {children}
    </span>
  );
}

/**
 * Bulleted list with hairline markers instead of default discs. The explicit
 * `role` restores the semantics `list-style: none` removes in Safari/VoiceOver.
 */
export function List({ children }: { children: React.ReactNode }) {
  return (
    <ul
      role="list"
      className="flex list-none flex-col gap-2.5 p-0 text-[0.95rem] leading-[1.7] text-foreground/85"
    >
      {children}
    </ul>
  );
}

export function LI({ children }: { children: React.ReactNode }) {
  return (
    <li className="relative pl-5">
      <span aria-hidden className="absolute left-0 top-[0.62em] h-px w-2.5 bg-primary/60" />
      {children}
    </li>
  );
}

/* -------------------------------------------------------------------- steps */

/**
 * A numbered procedure. The counter lives in a mono plate to the left of each
 * step, which is what makes a manual scannable: you can find "step 4" without
 * reading steps 1–3. The plate is CSS-generated and `aria-hidden`, so the list
 * role is what carries the ordinal for assistive tech — hence the explicit
 * `role="list"`, which `list-style: none` would otherwise strip.
 */
export function Steps({ children }: { children: React.ReactNode }) {
  return (
    <ol role="list" className="flex list-none flex-col gap-0 p-0 [counter-reset:docs-step]">
      {children}
    </ol>
  );
}

export function Step({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <li className="relative flex gap-4 border-l border-border/70 pb-6 pl-6 last:border-l-transparent last:pb-0 [counter-increment:docs-step]">
      <span
        aria-hidden
        className="absolute -left-[0.8125rem] top-0 flex size-[1.625rem] items-center justify-center rounded-full border border-primary/40 bg-background font-mono text-[0.7rem] text-primary tabular-nums before:content-[counter(docs-step,decimal-leading-zero)]"
      />
      <div className="flex min-w-0 flex-col gap-1.5 pt-0.5">
        <span className="text-[0.95rem] font-medium leading-snug text-foreground">{title}</span>
        {children ? (
          <div className="text-[0.9rem] leading-[1.7] text-muted-foreground">{children}</div>
        ) : null}
      </div>
    </li>
  );
}

/* ----------------------------------------------------------------- callouts */

const CALLOUT_TONE = {
  note: {
    rule: "bg-primary",
    label: "text-primary",
    surface: "border-primary/25 bg-primary/[0.06]",
  },
  tip: {
    rule: "bg-score-good",
    label: "text-score-good",
    surface: "border-score-good/25 bg-score-good/[0.06]",
  },
  warn: {
    rule: "bg-score-average",
    label: "text-score-average",
    surface: "border-score-average/30 bg-score-average/[0.07]",
  },
} as const;

interface CalloutProps {
  tone?: keyof typeof CALLOUT_TONE;
  /** Monospace label, e.g. "Watch out". Defaults to the tone's own word. */
  label?: string;
  children: React.ReactNode;
}

/**
 * An aside that must not be missed. The tone colour is carried by a label *word*
 * as well as the rule, so the distinction survives greyscale and colour-blindness
 * — colour is never the only signal anywhere in this app.
 */
export function Callout({ tone = "note", label, children }: CalloutProps) {
  const t = CALLOUT_TONE[tone];
  const word = label ?? { note: "Note", tip: "Tip", warn: "Watch out" }[tone];
  return (
    <aside className={cn("relative overflow-hidden rounded-md border py-3.5 pl-5 pr-4", t.surface)}>
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5", t.rule)} />
      <span
        className={cn("mb-1.5 block font-mono text-[0.65rem] uppercase tracking-[0.2em]", t.label)}
      >
        {word}
      </span>
      <div className="text-[0.9rem] leading-[1.7] text-foreground/85">{children}</div>
    </aside>
  );
}

/* ------------------------------------------------------------------ terminal */

/**
 * A command block, styled as an instrument readout: a hairline frame with a mono
 * caption strip rather than a plain grey box. The `<pre>` is focusable because it
 * scrolls — a scrollable region no keyboard can reach is a keyboard trap in
 * reverse — and untranslatable, because auto-translation rewrites commands.
 */
export function Terminal({ caption, children }: { caption?: string; children: React.ReactNode }) {
  return (
    <figure className="overflow-hidden rounded-md border border-border/70 bg-card/60">
      {caption ? (
        <figcaption className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3.5 py-2 font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-primary/70" />
          {caption}
        </figcaption>
      ) : null}
      <pre
        tabIndex={0}
        translate="no"
        aria-label={caption ? `${caption} commands` : undefined}
        className="overflow-x-auto px-4 py-3.5 font-mono text-[0.8rem] leading-[1.8] text-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {children}
      </pre>
    </figure>
  );
}

/* ---------------------------------------------------------------- spec table */

export interface SpecRow {
  term: React.ReactNode;
  /** Short mono value shown under the term, e.g. a default. */
  value?: React.ReactNode;
  detail: React.ReactNode;
}

/**
 * A settings reference: control on the left, its default as a mono value, and
 * what it actually does. A definition list rather than a `<table>` — these are
 * term/description pairs, not tabular data, and the `<dl>` reflows cleanly on a
 * phone where a three-column table would not.
 */
export function SpecList({ rows }: { rows: readonly SpecRow[] }) {
  return (
    <dl className="divide-y divide-border/60 rounded-md border border-border/70 bg-card/40">
      {rows.map((row, i) => (
        <div
          key={i}
          className="grid gap-1.5 px-4 py-3.5 sm:grid-cols-[minmax(0,12rem)_1fr] sm:gap-6"
        >
          <dt className="flex flex-col gap-1">
            <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-foreground">
              {row.term}
            </span>
            {row.value ? (
              <span className="font-mono text-[0.7rem] tabular-nums text-primary">{row.value}</span>
            ) : null}
          </dt>
          <dd className="text-[0.9rem] leading-[1.7] text-muted-foreground">{row.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ----------------------------------------------------------------- link-outs */

/** Link inside prose, underlined so it reads as navigation rather than emphasis. */
export function DocLink({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith("http");
  const className =
    "rounded-sm underline decoration-primary/40 underline-offset-4 transition-colors hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
        {children}
        {/* Announced, not drawn: the manual's few outbound links shouldn't each
            carry a glyph, but a new tab should never be a surprise. */}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
