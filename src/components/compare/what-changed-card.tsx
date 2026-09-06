"use client";

/**
 * The What Changed card (ROADMAP Phase E) — the third card on `/compare`,
 * beside Score Trend and Run Diff.
 *
 * Run Diff answers "we dropped 8 points". This answers "*why*": which individual
 * audits, opportunities and requests moved between exactly the two runs the
 * pickers above already select. It adds no second pair of pickers — the
 * selection is the console's, and this card is a lens on it.
 *
 * **It is lazy on purpose, and that is a Gate requirement rather than a
 * nicety.** A diff reads TWO stored LHRs server-side (~690 KB each, up to 1.5 MB),
 * so `/compare` must render its trend and score diff without ever touching a
 * stored report. `useRunDiff` fetches nothing until `active` is true, and
 * `active` is this card's own open state — so a plain visit to `/compare` issues
 * no request to `/api/reports/:runId/diff` at all. The one exception is arriving
 * through the Re-run lineage chip's "what changed" link, whose `changed=1` is
 * the user asking in the most literal way available.
 *
 * Two eligibility checks happen BEFORE any of that, so an impossible diff is
 * explained rather than fetched and failed: the same run on both sides, and a
 * run whose JSON report was never stored.
 *
 * SECURITY: `finalUrl` (surfaced by the URL-mismatch notice) and every request
 * URL in the tables come from the page under audit. They are rendered as text,
 * clamped, and — deliberately, as in Phase D — never linked.
 */

import { useMemo, useState } from "react";
import {
  FileDiff,
  FileQuestion,
  GitCompareArrows,
  Layers,
  Network,
  Sparkles,
  TriangleAlert,
  Zap,
} from "lucide-react";

import {
  Readout,
  ReadoutCell,
  ReadoutCells,
  ReadoutNote,
} from "@/components/audit/readout";
import { WhatChangedExplain } from "@/components/compare/what-changed-explain";
import {
  AuditsTable,
  DiffEmpty,
  OpportunitiesTable,
  ResourcesTable,
} from "@/components/compare/what-changed-tables";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useRunDiff } from "@/hooks/useRunDiff";
import {
  AUDIT_FILTERS,
  AUDIT_FILTER_LABELS,
  auditsEmptyReason,
  countByStatus,
  diffFinalHost,
  filterAuditDeltas,
  growthTone,
  opportunitiesEmptyReason,
  resourceRows,
  resourcesEmptyReason,
  summarizeRunDiff,
  type AuditFilter,
} from "@/lib/compare/what-changed-view";
import type { HistoryRow } from "@/lib/db/persistence";
import type { RunDiff } from "@/lib/reports/diff-types";
import { clampText } from "@/lib/reports/waterfall-view";
import { cn } from "@/lib/utils";

/** Mono uppercase tracked micro-cap — the house telemetry label. */
const SECTION_LABEL =
  "font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground";

/** Hairline between readout cells once they sit in a row, as in the Target band. */
const FACT_DIVIDER = "@2xl:border-l @2xl:border-border/60 @2xl:pl-6";

/** The card's tabs. `explain` is the AI hand-off, and is always mounted last. */
type DiffTab = "audits" | "opportunities" | "resources" | "explain";

function asTab(value: string): DiffTab {
  switch (value) {
    case "opportunities":
    case "resources":
    case "explain":
      return value;
    default:
      return "audits";
  }
}

export interface WhatChangedCardProps {
  /** The earlier / reference run — the console's baseline picker. */
  baseline: HistoryRow;
  /** The later / subject run — the console's comparison picker. */
  comparison: HistoryRow;
  /**
   * Whether the card starts open. False for a plain `/compare` visit (which then
   * reads no stored report at all); true only for a `changed=1` deep link that
   * resolved to this exact pair.
   */
  defaultOpen?: boolean;
  className?: string;
}

export function WhatChangedCard({
  baseline,
  comparison,
  defaultOpen = false,
  className,
}: WhatChangedCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  // Two reasons a diff is impossible, checked before the hook is ever armed —
  // an explanation beats a fetch that can only fail.
  const samePair = baseline.id === comparison.id;
  const missingReport = !baseline.hasJsonReport || !comparison.hasJsonReport;
  const eligible = !samePair && !missingReport;

  const { status, diff, error, retry } = useRunDiff(
    baseline.id,
    comparison.id,
    open && eligible,
  );

  let body: React.ReactNode;
  if (samePair) {
    body = (
      <Empty className="rounded-md border border-dashed border-border/60 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitCompareArrows />
          </EmptyMedia>
          <EmptyTitle>Baseline and comparison are the same run</EmptyTitle>
          <EmptyDescription>
            A run cannot differ from itself. Pick two different runs above and this card will
            show every audit, opportunity and request that moved between them.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (missingReport) {
    const which = !baseline.hasJsonReport
      ? !comparison.hasJsonReport
        ? "Neither of these runs"
        : "The baseline run"
      : "The comparison run";
    body = (
      <Empty className="rounded-md border border-dashed border-border/60 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestion />
          </EmptyMedia>
          <EmptyTitle>No stored report to diff</EmptyTitle>
          <EmptyDescription>
            {which} kept a full JSON report, and an audit-level diff is built by reading both of
            them. The score and Core Web Vitals diff above still works, because it uses the
            values saved on the run itself.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (!open) {
    body = (
      <Empty className="rounded-md border border-dashed border-border/60 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileDiff />
          </EmptyMedia>
          <EmptyTitle>See what changed between these two runs</EmptyTitle>
          <EmptyDescription>
            Comparing at the audit level means reading both stored reports, so it happens only
            when you ask for it — everything above is derived from values already on the page.
          </EmptyDescription>
        </EmptyHeader>
        <Button onClick={() => setOpen(true)}>
          <FileDiff data-icon="inline-start" />
          Show what changed
        </Button>
      </Empty>
    );
  } else if (status === "error") {
    body = (
      <div className="flex flex-col gap-4">
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Could not read the diff</AlertTitle>
          <AlertDescription>
            {error?.message ?? "Something went wrong reading the two stored reports."}
          </AlertDescription>
        </Alert>
        <Button variant="outline" size="sm" className="self-start" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  } else if (status === "loaded" && diff) {
    body = <DiffBody diff={diff} />;
  } else {
    body = <DiffSkeleton />;
  }

  return (
    <Card className={className}>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.16em]">
          <FileDiff aria-hidden className="size-3.5 text-primary" />
          What Changed
        </CardTitle>
        <CardDescription className="text-pretty">
          The audit-level diff of the two runs selected above: the individual audits,
          opportunities and requests behind the score change.
        </CardDescription>
        {eligible && open ? (
          <CardAction>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Hide
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="@container flex flex-col gap-5">{body}</CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

/** Stand-in while the two reports are read. Mirrors the loaded layout's shape. */
function DiffSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Reading both stored reports…</span>
      <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-3">
        <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full bg-muted/40" />
          ))}
        </div>
        <Skeleton className="h-3 w-64 bg-muted/40" />
      </div>
      <Skeleton className="h-8 w-72 bg-muted/40" />
      <Skeleton className="h-64 w-full bg-muted/40" />
    </div>
  );
}

/** The loaded diff: a mismatch notice when earned, a readout, then the tables. */
function DiffBody({ diff }: { diff: RunDiff }) {
  const [tab, setTab] = useState<DiffTab>("audits");
  const [filter, setFilter] = useState<AuditFilter>("all");

  const summary = useMemo(() => summarizeRunDiff(diff), [diff]);
  const audits = useMemo(() => filterAuditDeltas(diff.audits, filter), [diff.audits, filter]);
  const requests = useMemo(() => resourceRows(diff.resources), [diff.resources]);
  const finalHost = useMemo(() => diffFinalHost(diff), [diff]);

  const auditCounts = useMemo(() => countByStatus(diff.audits), [diff.audits]);

  const auditsEmpty = auditsEmptyReason(diff, audits.length, filter);
  const opportunitiesEmpty = opportunitiesEmptyReason(diff);
  const resourcesEmpty = resourcesEmptyReason(diff);

  return (
    <div className="flex flex-col gap-5">
      {diff.urlMismatch ? <UrlMismatch diff={diff} /> : null}

      {/* Readout — the four figures the whole card is about, in the same bezel
          the Target band uses so the two read as one instrument. */}
      <Readout>
        <ReadoutCells className="grid grid-cols-2 items-end gap-x-6 gap-y-3 @2xl:grid-cols-4 @2xl:gap-x-0">
          <ReadoutCell
            icon={<Layers className="size-3" aria-hidden />}
            label="Audits moved"
            value={summary.auditsLabel}
          />
          <ReadoutCell
            className={FACT_DIVIDER}
            icon={<Zap className="size-3" aria-hidden />}
            label="Opportunities"
            value={summary.opportunitiesLabel}
          />
          <ReadoutCell
            className={FACT_DIVIDER}
            icon={<Network className="size-3" aria-hidden />}
            label="Requests"
            value={summary.resourcesUnavailable ? "—" : summary.requestCountDelta}
            tone={
              summary.resourcesUnavailable
                ? "default"
                : growthTone(diff.resources.requestCountDelta)
            }
          />
          <ReadoutCell
            className={FACT_DIVIDER}
            icon={<FileDiff className="size-3" aria-hidden />}
            label="Transfer"
            value={summary.resourcesUnavailable ? "—" : summary.transferDelta}
            tone={
              summary.resourcesUnavailable
                ? "default"
                : growthTone(diff.resources.transferSizeDelta)
            }
          />
        </ReadoutCells>
        <ReadoutNote>
          {summary.auditsTotal > summary.auditsShown
            ? `Showing the ${summary.auditsShown} biggest of ${summary.auditsTotal} audits that moved. `
            : ""}
          {summary.unchangedAuditCount}{" "}
          {summary.unchangedAuditCount === 1 ? "audit" : "audits"} both runs carried did not
          move and are not listed.
        </ReadoutNote>
      </Readout>

      <Tabs value={tab} onValueChange={(value) => setTab(asTab(value))} className="gap-4">
        {/* The strip scrolls rather than wrapping: four triggers with counts do
            not fit a 320px card, and a wrapped tab row reads as two rows of
            unrelated buttons. */}
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList variant="line" className="h-8 w-max justify-start">
            <TabsTrigger value="audits" className="flex-none px-3">
              Audits
              <TabCount>{summary.auditsShown}</TabCount>
            </TabsTrigger>
            <TabsTrigger value="opportunities" className="flex-none px-3">
              Opportunities
              <TabCount>{summary.opportunitiesShown}</TabCount>
            </TabsTrigger>
            <TabsTrigger value="resources" className="flex-none px-3">
              Requests
              <TabCount>
                {summary.urlRowsShown}
                <span className="sr-only"> URLs listed</span>
              </TabCount>
            </TabsTrigger>
            <TabsTrigger value="explain" className="flex-none px-3">
              <Sparkles data-icon="inline-start" />
              Explain
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="audits" className="flex flex-col gap-3 outline-none">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            {/* The headline is the two statuses that actually moved the score.
                Presence is stated after them, and quieter, because it is
                routine run-to-run variation — see the note below. */}
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className={SECTION_LABEL}>
                <span className="text-score-poor tabular-nums">
                  {auditCounts.regressed}
                </span>{" "}
                regressed
              </span>
              <span className={SECTION_LABEL}>
                <span className="text-score-good tabular-nums">
                  {auditCounts.improved}
                </span>{" "}
                improved
              </span>
              <span className={SECTION_LABEL}>
                <span className="tabular-nums">
                  {auditCounts.added + auditCounts.removed}
                </span>{" "}
                presence only
              </span>
            </span>
            <div className="-mx-1 max-w-full overflow-x-auto px-1">
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={filter}
                onValueChange={(value) => {
                  // Radix emits "" when the active item is pressed again; keep the
                  // current filter rather than falling into an unlabelled state.
                  if (value) setFilter(value as AuditFilter);
                }}
                aria-label="Filter audits by how they moved"
              >
                {AUDIT_FILTERS.map((option) => (
                  <ToggleGroupItem
                    key={option}
                    value={option}
                    className="px-2.5 font-mono text-[0.65rem] uppercase tracking-[0.12em]"
                  >
                    {AUDIT_FILTER_LABELS[option]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>
          {auditCounts.added + auditCounts.removed > 0 ? (
            <Note>
              Appeared / disappeared audits are presence changes, not verdicts: Lighthouse omits
              audits such as <Mono>bf-cache</Mono> and <Mono>modern-http-insight</Mono> from some
              runs of the same page on the same version. The regressions above them are what
              actually moved the score, and they are listed first.
            </Note>
          ) : null}
          {auditsEmpty ? (
            <DiffEmpty
              section="audits"
              reason={auditsEmpty}
              filter={filter}
              hiddenCount={diff.audits.length}
            />
          ) : (
            <AuditsTable audits={audits} />
          )}
        </TabsContent>

        <TabsContent value="opportunities" className="outline-none">
          {opportunitiesEmpty ? (
            <DiffEmpty section="opportunities" reason={opportunitiesEmpty} />
          ) : (
            <OpportunitiesTable opportunities={diff.opportunities} />
          )}
        </TabsContent>

        <TabsContent value="resources" className="flex flex-col gap-3 outline-none">
          {/* Totals FIRST. They are summed over the page, so they are the only
              request figures immune to beacon churn (see the note below); the
              per-URL lists underneath are not. */}
          {summary.resourcesUnavailable ? null : (
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
              <Totals
                label="Requests"
                from={String(summary.baselineRequestCount)}
                to={String(summary.comparisonRequestCount)}
                delta={summary.requestCountDelta}
                raw={diff.resources.requestCountDelta}
              />
              <Totals
                label="Transferred"
                from={summary.transferBaseline}
                to={summary.transferComparison}
                delta={summary.transferDelta}
                raw={diff.resources.transferSizeDelta}
              />
              <span className={SECTION_LABEL}>
                <span className="tabular-nums">{summary.urlRowsLabel}</span> of{" "}
                <span className="tabular-nums">{summary.urlKeysTotal}</span> URLs moved
              </span>
            </div>
          )}
          {resourcesEmpty ? (
            <DiffEmpty section="resources" reason={resourcesEmpty} />
          ) : (
            <>
              <Note>
                Rows are keyed by the full URL, query string included. Analytics beacons mint a
                fresh session id or cache-buster on every run, so one re-requested beacon shows
                up twice below — once as <Mono>GONE</Mono>, once as <Mono>NEW</Mono>. The request
                and transfer totals above do not move with that churn; these lists do. Requests
                whose size actually changed are listed first.
              </Note>
              <ResourcesTable rows={requests} finalHost={finalHost} />
            </>
          )}
        </TabsContent>

        {/* `forceMount` so a finished explanation survives a tab switch — the
            stream is expensive and deliberately uncached, so losing it to a
            click would mean paying for it twice. */}
        <TabsContent
          value="explain"
          forceMount
          className="outline-none data-[state=inactive]:hidden"
        >
          <WhatChangedExplain
            key={`${diff.baseline.runId}:${diff.comparison.runId}`}
            diff={diff}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** A caveat line under a section heading — quiet, but not hidden. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-pretty text-xs leading-relaxed text-muted-foreground">{children}</p>
  );
}

/** An identifier inside prose. */
function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[0.9em] text-foreground/80" translate="no">
      {children}
    </span>
  );
}

/**
 * One page-wide total: `before → after` with its delta. These are the figures a
 * reader should trust when the per-URL lists are full of beacon churn, so they
 * print both endpoints rather than only the movement.
 */
function Totals({
  label,
  from,
  to,
  delta,
  raw,
}: {
  label: string;
  from: string;
  to: string;
  delta: string;
  /** The unformatted delta, for the tone only. */
  raw: number;
}) {
  const tone = growthTone(raw);
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={SECTION_LABEL}>{label}</span>
      <span className="font-mono text-xs tabular-nums whitespace-nowrap text-muted-foreground">
        {from} → <span className="text-foreground">{to}</span>
      </span>
      <span
        className={cn(
          "font-mono text-xs tabular-nums whitespace-nowrap",
          tone === "warn"
            ? "text-score-poor"
            : tone === "good"
              ? "text-score-good"
              : "text-muted-foreground",
        )}
      >
        {delta}
      </span>
    </span>
  );
}

/** The count that trails a tab label. */
function TabCount({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[0.65rem] tabular-nums text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * The two runs finished on different URLs. Not an error — a redirect target can
 * legitimately change — but it has to be said out loud rather than presented as
 * a regression, because the diff below may be comparing two different pages.
 *
 * Both URLs are page-controlled: text only, clamped, never a link.
 */
function UrlMismatch({ diff }: { diff: RunDiff }) {
  return (
    <Alert>
      <TriangleAlert />
      <AlertTitle>These runs finished on different URLs</AlertTitle>
      <AlertDescription>
        <p className="text-pretty">
          A redirect target can legitimately change, but the differences below may be between
          two different pages rather than a regression of one.
        </p>
        <dl className="grid gap-1 font-mono text-[0.7rem]">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-muted-foreground uppercase tracking-[0.12em]">Baseline</dt>
            <dd className="min-w-0 wrap-anywhere" translate="no">
              {clampText(diff.baseline.finalUrl, 240) || "—"}
            </dd>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-muted-foreground uppercase tracking-[0.12em]">Comparison</dt>
            <dd className="min-w-0 wrap-anywhere" translate="no">
              {clampText(diff.comparison.finalUrl, 240) || "—"}
            </dd>
          </div>
        </dl>
      </AlertDescription>
    </Alert>
  );
}
