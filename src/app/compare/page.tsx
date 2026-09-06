import { PageHeader } from "@/components/page-header";
import { CompareConsole } from "@/components/compare/compare-console";
import type { CompareSelectionParams } from "@/lib/compare/lineage";
import { listHistory } from "@/lib/db/persistence";

// Reads the SQLite archive at request time — must run on Node and never be
// statically prerendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/compare`, optionally deep-linked.
 *
 * `?url=…&baseline=<runId>&comparison=<runId>` preselects a pair — the link a
 * Re-run's lineage chip produces — and `&changed=1` additionally opens the What
 * Changed card, which is the only way a stored report is read on arrival. The
 * query is resolved against the archive inside the console (see
 * `resolveCompareSelection`), so a link naming a run that has since been deleted
 * degrades to this page's own defaults rather than a dangling selection.
 */
export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<CompareSelectionParams>;
}) {
  const params = await searchParams;
  const rows = listHistory();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="03 — Compare"
        title="Compare & Trends"
        description="Track a URL's Lighthouse scores over time, then diff any two of its runs — score and Core Web Vitals deltas with direction, and, on demand, the individual audits, opportunities and requests behind them."
      />

      <CompareConsole runs={rows} initial={params} />
    </div>
  );
}
