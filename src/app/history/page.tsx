import { PageHeader } from "@/components/page-header";
import { HistoryTable } from "@/components/history/history-table";
import { Badge } from "@/components/ui/badge";
import { listHistory } from "@/lib/db/persistence";

// Reads the SQLite archive at request time — must run on Node and never be
// statically prerendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function HistoryPage() {
  const rows = listHistory();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="02 — Archive"
        title="History"
        description="Every run is persisted to local SQLite and report files on disk, ready for before/after comparison."
      >
        <Badge variant="outline" className="font-mono text-xs">
          {rows.length} {rows.length === 1 ? "run" : "runs"}
        </Badge>
      </PageHeader>

      <HistoryTable rows={rows} />
    </div>
  );
}
