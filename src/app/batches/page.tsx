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
  const batches = listBatches();
  const runs = listHistory();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="04 — Batches"
        title="Batch Summary"
        description="Each audit batch summarised: average scores per category, best and worst pages, and pass/fail counts against your own thresholds."
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
            <EmptyTitle>No batches yet</EmptyTitle>
            <EmptyDescription>
              Run an audit to populate the archive. Every batch you run is
              summarised here automatically.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <BatchSummaryConsole batches={batches} runs={runs} />
      )}
    </div>
  );
}
