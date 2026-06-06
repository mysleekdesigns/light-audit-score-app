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
  // The archive de-duplicates to one row per URL (latest run); show that count,
  // with the raw run total available on hover.
  const urlCount = new Set(rows.map((row) => row.url)).size;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="02 — Archive"
        title="History"
        description="One row per URL — its latest run, with the trend versus the previous run. Every run stays persisted to local SQLite and report files on disk for before/after comparison."
      >
        <Badge
          variant="outline"
          className="font-mono text-xs"
          title={`${rows.length} ${rows.length === 1 ? "run" : "runs"} persisted`}
        >
          {urlCount} {urlCount === 1 ? "URL" : "URLs"}
        </Badge>
      </PageHeader>

      <HistoryTable rows={rows} />
    </div>
  );
}
