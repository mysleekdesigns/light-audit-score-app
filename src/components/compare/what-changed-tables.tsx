"use client";

/**
 * The three tables inside the What Changed card (ROADMAP Phase E): which audits
 * moved, which opportunities moved, and which requests arrived, grew or went
 * away between two runs.
 *
 * Presentation only. Every decision these rows depend on — the signed number
 * formatting, the score-vs-measurement choice per row, the status marks, the
 * filter and the empty-state reasons — lives in `@/lib/compare/what-changed-view`,
 * where Vitest (`environment: "node"`, no jsdom in this project) tests it
 * directly. This file is the same kind of dense sortable surface as Phase D's
 * `RequestWaterfall` and follows its structure deliberately.
 *
 * SECURITY: every `url` / `path` / `host` shown by {@link ResourcesTable} is
 * chosen by the page under audit, so it is attacker-controlled (see the module
 * note on `@/lib/reports/diff-types`). They are rendered as text and as `title`
 * attributes only — React escapes both — and, exactly as in Phase D, there are
 * deliberately **no links**: routing dozens of attacker-chosen navigation
 * targets into this card's tab order is a surface, and ROADMAP Phase C's L1
 * finding (a hostile audited site forging a UI line) is the standing reminder.
 * Audit and opportunity titles are Lighthouse's own text, not page-authored,
 * and are clamped anyway.
 */

import { memo } from "react";
import { FileQuestion, Filter, Network, ShieldCheck } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AUDIT_FILTER_LABELS,
  DELTA_MARKS,
  auditNumericNote,
  auditPresenceNote,
  auditRowValues,
  deltaTone,
  isInformationalAudit,
  opportunityRowValues,
  resourceChangeValue,
  resourceCountNote,
  resourceLabel,
  type AuditFilter,
  type DeltaTone,
  type EmptyReason,
} from "@/lib/compare/what-changed-view";
import { CATEGORY_SHORT_LABELS } from "@/lib/scores";
import type {
  AuditDelta,
  DeltaStatus,
  OpportunityDelta,
  ResourceDelta,
} from "@/lib/reports/diff-types";
import { ABSENT, clampText, formatBytes } from "@/lib/reports/waterfall-view";
import { scoreBandChipClass } from "@/lib/scores";
import { cn } from "@/lib/utils";

/** Header label styling — mono, uppercase, tracked (matches the waterfall). */
const HEAD_LABEL = "font-mono text-[0.65rem] uppercase tracking-[0.16em]";

/** Dense body cell: tighter than the primitive's `p-2`, since lists run to 80 rows. */
const BODY_CELL = "px-2 py-1.5 align-top";

/** Right-aligned mono figure column. */
const FIGURE_CELL = "text-right font-mono text-xs tabular-nums whitespace-nowrap";

const MARK_CHIP =
  "inline-flex h-[1.05rem] shrink-0 items-center rounded-[3px] border px-1 font-mono text-[0.55rem] uppercase tracking-[0.08em]";

/**
 * Tone → chip classes, reusing the score bands rather than inventing tokens.
 * `neutral` is the unscored band, which is the right answer twice over: it is
 * the same chip Phase D's provenance-only `3P` mark uses, and `added`/`removed`
 * are provenance, not verdicts.
 */
const TONE_CHIP: Record<DeltaTone, string> = {
  worse: scoreBandChipClass("poor"),
  better: scoreBandChipClass("good"),
  neutral: scoreBandChipClass("none"),
};

/** Tone → text colour for the Δ column. Always paired with a printed mark. */
const TONE_TEXT: Record<DeltaTone, string> = {
  worse: "text-score-poor",
  better: "text-score-good",
  neutral: "text-muted-foreground",
};

/** Scroll container for one table: wide rows scroll here, never on the page. */
const SCROLLER = "max-h-[26rem] min-h-0 overflow-auto overscroll-contain rounded-md border border-border/60";

/**
 * `border-separate` (rather than the primitive's collapsed default) is what keeps
 * the sticky header's bottom hairline painted while rows scroll under it — a
 * collapsed border travels with the cell. Same trick as the waterfall.
 */
const TABLE = "w-full caption-bottom border-separate border-spacing-0 text-sm";

const STICKY_HEAD =
  "sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 [&_th]:border-b [&_th]:border-border/60";

const ROWS = "[&_td]:border-b [&_td]:border-border/40 [&_tr:last-child_td]:border-0";

/* -------------------------------------------------------------------------- */
/* Shared row furniture                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The chip that says how a row moved. The abbreviation carries the meaning and
 * the tint only reinforces it, so the tables read correctly in greyscale — the
 * rule Phase D's `RB` / `3P` marks set and Phase C's threshold copy repeated.
 */
function DeltaMark({ status }: { status: DeltaStatus }) {
  const mark = DELTA_MARKS[status];
  return (
    <span className={cn(MARK_CHIP, TONE_CHIP[deltaTone(status)])}>
      <span aria-hidden>{mark.abbr}</span>
      <span className="sr-only">{mark.label}</span>
    </span>
  );
}

/** A neutral chip for an audit that carries no scoring weight. */
function InfoMark() {
  return (
    <span className={cn(MARK_CHIP, scoreBandChipClass("none"))}>
      <span aria-hidden>INFO</span>
      <span className="sr-only">Informative only — carries no scoring weight</span>
    </span>
  );
}

/** The Δ cell: a signed figure tinted by tone, with an SR word for the direction. */
function ChangeCell({ value, status }: { value: string; status: DeltaStatus }) {
  const tone = deltaTone(status);
  return (
    <TableCell className={cn(BODY_CELL, FIGURE_CELL, TONE_TEXT[tone])}>
      {value}
      <span className="sr-only"> — {DELTA_MARKS[status].label}</span>
    </TableCell>
  );
}

/** A column header. `numeric` right-aligns it over its figures. */
function Head({
  children,
  numeric = false,
  className,
}: {
  children: React.ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <TableHead
      scope="col"
      className={cn(
        HEAD_LABEL,
        "h-8 px-2 text-muted-foreground",
        numeric && "text-right",
        className,
      )}
    >
      {children}
    </TableHead>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty states                                                                */
/* -------------------------------------------------------------------------- */

/** Which table is empty — only used to pick the right sentence. */
export type DiffSection = "audits" | "opportunities" | "resources";

/**
 * Copy per (section, reason). Four reasons, four different facts: the runs were
 * identical, this section alone is quiet, the active filter hides everything, or
 * a report predates the network trace. Saying "nothing changed" for the last one
 * would be a lie about the data, which is the mistake Phase D's empty states
 * were written to avoid.
 */
function emptyCopy(
  section: DiffSection,
  reason: EmptyReason,
  filter: AuditFilter,
  hiddenCount: number,
): { title: string; description: React.ReactNode } {
  if (reason === "identical") {
    return {
      title: "These two runs are identical",
      description:
        "Nothing measurable moved between them — the same audits scored the same, the same opportunities are worth the same, and the same requests transferred the same bytes.",
    };
  }

  if (reason === "filtered") {
    const label = AUDIT_FILTER_LABELS[filter].toLowerCase();
    return {
      title: `Nothing ${label} here`,
      description: `${hiddenCount} ${hiddenCount === 1 ? "audit" : "audits"} moved between these runs, but none of them are in the “${AUDIT_FILTER_LABELS[filter]}” group. Switch back to All to see them.`,
    };
  }

  if (reason === "unavailable") {
    return {
      title: "No network trace to diff",
      description: (
        <>
          One of these runs was stored without a{" "}
          <span className="font-mono">network-requests</span> audit — reports saved before the
          waterfall existed have none, so there is nothing to compare. Re-run both pages to
          capture one.
        </>
      ),
    };
  }

  // none-in-section: something else in this diff moved, just not here.
  switch (section) {
    case "audits":
      return {
        title: "No audit moved",
        description:
          "Every audit both runs carried scored the same. Other parts of this diff did change — check the other tabs.",
      };
    case "opportunities":
      return {
        title: "No opportunity moved",
        description:
          "Lighthouse estimated the same savings in both runs, so no performance opportunity got cheaper or more expensive.",
      };
    case "resources":
      return {
        title: "The same requests, at the same sizes",
        description:
          "Both runs fetched the same URLs the same number of times and transferred the same bytes. Nothing was added, dropped or grew.",
      };
  }
}

/** Icon per empty state: the trace-missing one is a question, not a verdict. */
function EmptyIcon({ section, reason }: { section: DiffSection; reason: EmptyReason }) {
  if (reason === "unavailable") return <FileQuestion />;
  if (reason === "filtered") return <Filter />;
  if (section === "resources") return <Network />;
  return <ShieldCheck />;
}

/** The honest empty state for one section. */
export function DiffEmpty({
  section,
  reason,
  filter = "all",
  hiddenCount = 0,
}: {
  section: DiffSection;
  reason: EmptyReason;
  /** The active audit filter — only read for the `filtered` reason. */
  filter?: AuditFilter;
  /** How many rows the filter is hiding — only read for the `filtered` reason. */
  hiddenCount?: number;
}) {
  const copy = emptyCopy(section, reason, filter, hiddenCount);
  return (
    <Empty className="rounded-md border border-dashed border-border/60 py-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <EmptyIcon section={section} reason={reason} />
        </EmptyMedia>
        <EmptyTitle>{copy.title}</EmptyTitle>
        <EmptyDescription>{copy.description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/* -------------------------------------------------------------------------- */
/* Audits                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One audit row: what it is, what it scored on each side, and how far it moved.
 *
 * Memoised because switching the filter otherwise re-renders every cell subtree
 * for a change that only narrows the list: `audit` objects come straight from
 * the fetched payload and keep their identity, so the memo actually hits.
 */
const AuditRow = memo(function AuditRow({ audit }: { audit: AuditDelta }) {
  const values = auditRowValues(audit);
  // A presence row has no movement to describe, so it says which side it was on
  // instead — see `auditPresenceNote`. Only one of the two is ever non-null.
  const presence = auditPresenceNote(audit);
  const note = presence ?? auditNumericNote(audit);
  const categories = audit.categories.map((c) => CATEGORY_SHORT_LABELS[c]).join(" · ");

  return (
    <TableRow className="border-border/50 hover:bg-muted/40">
      {/* `max-w-0` with a min-width is what lets the title truncate instead of
          forcing the table wider than the card (same trick as the waterfall). */}
      <TableCell className={cn(BODY_CELL, "min-w-[12rem] max-w-0")}>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              title={clampText(audit.description, 280)}
              className="truncate text-xs text-foreground"
            >
              {clampText(audit.title, 160)}
            </span>
            <DeltaMark status={audit.status} />
            {isInformationalAudit(audit) ? <InfoMark /> : null}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 font-mono text-[0.6rem] text-muted-foreground">
            <span className="truncate" translate="no">
              {clampText(audit.id, 80)}
            </span>
            {categories ? (
              <span className="uppercase tracking-[0.08em]">{categories}</span>
            ) : null}
            {note ? (
              <span className={presence ? "italic" : "tabular-nums"}>{note}</span>
            ) : null}
          </span>
        </div>
      </TableCell>

      <TableCell className={cn(BODY_CELL, FIGURE_CELL, "text-muted-foreground")}>
        {values.baseline}
      </TableCell>
      <TableCell className={cn(BODY_CELL, FIGURE_CELL)}>{values.comparison}</TableCell>
      <ChangeCell value={values.change} status={audit.status} />
    </TableRow>
  );
});

/**
 * The audits table. Rows arrive already ranked worst-first by the differ, and
 * nothing here reorders them — the filter only narrows.
 */
export function AuditsTable({ audits }: { audits: readonly AuditDelta[] }) {
  return (
    <div className={SCROLLER}>
      <table className={cn(TABLE, "min-w-[34rem]")}>
        <caption className="sr-only">
          Audits that moved between the two runs, worst first. Scored audits show 0–100 scores;
          scoreless diagnostics show Lighthouse&apos;s own measurement.
        </caption>
        <TableHeader className={STICKY_HEAD}>
          <TableRow className="hover:bg-transparent">
            <Head className="w-full">Audit</Head>
            <Head numeric>Baseline</Head>
            <Head numeric>Comparison</Head>
            <Head numeric>Δ</Head>
          </TableRow>
        </TableHeader>
        <TableBody className={ROWS}>
          {audits.map((audit) => (
            <AuditRow key={audit.id} audit={audit} />
          ))}
        </TableBody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Opportunities                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The opportunities table. Ranked by the CHANGE in estimated savings, so the
 * biggest new waste is first — and the Δ column's tone comes from the differ's
 * `status`, never from the sign, because more savings available means the page
 * got *worse*.
 */
export function OpportunitiesTable({
  opportunities,
}: {
  opportunities: readonly OpportunityDelta[];
}) {
  return (
    <div className={SCROLLER}>
      <table className={cn(TABLE, "min-w-[32rem]")}>
        <caption className="sr-only">
          Performance opportunities whose estimated savings changed, biggest regression first. A
          larger saving means more time is being wasted.
        </caption>
        <TableHeader className={STICKY_HEAD}>
          <TableRow className="hover:bg-transparent">
            <Head className="w-full">Opportunity</Head>
            <Head numeric>Baseline</Head>
            <Head numeric>Comparison</Head>
            <Head numeric>Δ waste</Head>
          </TableRow>
        </TableHeader>
        <TableBody className={ROWS}>
          {opportunities.map((opportunity) => {
            const values = opportunityRowValues(opportunity);
            return (
              <TableRow
                key={opportunity.id}
                className="border-border/50 hover:bg-muted/40"
              >
                <TableCell className={cn(BODY_CELL, "min-w-[12rem] max-w-0")}>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        title={clampText(opportunity.description, 280)}
                        className="truncate text-xs text-foreground"
                      >
                        {clampText(opportunity.title, 160)}
                      </span>
                      <DeltaMark status={opportunity.status} />
                    </span>
                    <span
                      className="truncate font-mono text-[0.6rem] text-muted-foreground"
                      translate="no"
                    >
                      {clampText(opportunity.id, 80)}
                    </span>
                  </div>
                </TableCell>
                <TableCell className={cn(BODY_CELL, FIGURE_CELL, "text-muted-foreground")}>
                  {values.baseline}
                </TableCell>
                <TableCell className={cn(BODY_CELL, FIGURE_CELL)}>{values.comparison}</TableCell>
                <ChangeCell value={values.change} status={opportunity.status} />
              </TableRow>
            );
          })}
        </TableBody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Resources                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One request row. Every string in it is page-authored — text only, no links.
 * Memoised for the same reason as {@link AuditRow}: the list runs to 120 rows.
 */
const ResourceRow = memo(function ResourceRow({
  row,
  finalHost,
}: {
  row: ResourceDelta;
  finalHost: string;
}) {
  const label = resourceLabel(row, finalHost);
  const countNote = resourceCountNote(row);
  // Hover detail for the parts that don't earn a column. Clamped, because a
  // `data:` URL is a legitimate row and can be megabytes of base64.
  const detail = [clampText(row.url, 240), row.thirdParty ? "Third-party" : null]
    .filter(Boolean)
    .join("\n");

  return (
    <TableRow className="border-border/50 hover:bg-muted/40">
      <TableCell className={cn(BODY_CELL, "min-w-[10rem] max-w-0")}>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              title={detail}
              translate="no"
              className={cn(
                "truncate font-mono text-xs",
                label.crossHost ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {label.text}
            </span>
            <DeltaMark status={row.status} />
            {row.thirdParty ? (
              <span className={cn(MARK_CHIP, scoreBandChipClass("none"))}>
                <span aria-hidden>3P</span>
                <span className="sr-only">Third-party</span>
              </span>
            ) : null}
          </span>
          {countNote ? (
            <span className="font-mono text-[0.6rem] tabular-nums text-muted-foreground">
              requested {countNote}
            </span>
          ) : null}
        </div>
      </TableCell>

      <TableCell
        className={cn(
          BODY_CELL,
          "font-mono text-[0.65rem] uppercase tracking-[0.08em] whitespace-nowrap text-muted-foreground",
        )}
      >
        {row.resourceType || ABSENT}
      </TableCell>
      <TableCell className={cn(BODY_CELL, FIGURE_CELL, "text-muted-foreground")}>
        {formatBytes(row.baselineTransferSize)}
      </TableCell>
      <TableCell className={cn(BODY_CELL, FIGURE_CELL)}>
        {formatBytes(row.comparisonTransferSize)}
      </TableCell>
      <ChangeCell value={resourceChangeValue(row)} status={row.status} />
    </TableRow>
  );
});

/**
 * The requests table: everything the page started fetching, then everything that
 * grew, then everything it stopped fetching.
 */
export function ResourcesTable({
  rows,
  finalHost,
}: {
  rows: readonly ResourceDelta[];
  finalHost: string;
}) {
  return (
    <div className={SCROLLER}>
      <table className={cn(TABLE, "min-w-[36rem]")}>
        <caption className="sr-only">
          Requests whose size changed, then requests only the comparison run made, then requests
          only the baseline run made. Rows are keyed by the full URL, so a beacon re-requested
          with a new query string appears in both of the last two groups. URLs come from the
          audited page and are shown as text only.
        </caption>
        <TableHeader className={STICKY_HEAD}>
          <TableRow className="hover:bg-transparent">
            <Head className="w-full">Request</Head>
            <Head>Type</Head>
            <Head numeric>Baseline</Head>
            <Head numeric>Comparison</Head>
            <Head numeric>Δ</Head>
          </TableRow>
        </TableHeader>
        <TableBody className={ROWS}>
          {rows.map((row) => (
            <ResourceRow key={`${row.status}:${row.url}`} row={row} finalHost={finalHost} />
          ))}
        </TableBody>
      </table>
    </div>
  );
}
