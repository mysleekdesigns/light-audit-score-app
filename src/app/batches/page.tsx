import { Layers } from "lucide-react";

import { BatchSummaryConsole } from "@/components/batch-summary/batch-summary-console";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { listBatches, listHistory } from "@/lib/db/persistence";

// Reads the SQLite archive at request time — must run on Node and never be
// statically prerendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function BatchesPage() {
  // Cancelled batches are dropped from this view. A stopped batch has no summary
  // worth reading — averages, best/worst and the threshold tally all describe a
  // run that never finished — and its card would take a grid slot from a batch
  // that does. Whatever pages it did complete before the stop are still
  // persisted and still listed on the History page.
  const allBatches = listBatches();
  const batches = allBatches.filter((batch) => batch.status !== "cancelled");
  // Only used to tell "you have run nothing yet" apart from "everything you ran
  // was cancelled", so the empty state doesn't claim the archive is untouched.
  const cancelledOnly = batches.length === 0 && allBatches.length > 0;
  const runs = listHistory();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="04 — Batches"
        title="Batch Summary"
        description="Each completed audit batch summarised: average scores per category, best and worst pages, and pass/fail counts against your own thresholds. Cancelled batches are left out — the pages they did finish are still on the History page."
      >
        <Badge variant="outline" className="font-mono text-xs">
          {batches.length} {batches.length === 1 ? "batch" : "batches"}
        </Badge>
      </PageHeader>

      {batches.length === 0 ? (
        <Empty className="border border-border/60">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Layers />
            </EmptyMedia>
            <EmptyTitle>
              {cancelledOnly ? "Nothing to summarise" : "No batches yet"}
            </EmptyTitle>
            <EmptyDescription>
              {cancelledOnly
                ? "Every batch in the archive was cancelled before it finished, so there is nothing to summarise. Let a batch run to completion and it appears here automatically."
                : "Run an audit to populate the archive. Every batch you run is summarised here automatically."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <BatchSummaryConsole batches={batches} runs={runs} />
      )}
    </div>
  );
}
