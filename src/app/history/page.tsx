import { PageHeader } from "@/components/page-header";
import { HistoryTable } from "@/components/history/history-table";
import { Badge } from "@/components/ui/badge";
import { listHistory } from "@/lib/db/persistence";

// Reads the SQLite archive at request time — must run on Node and never be
// statically prerendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A page's hostname, `www.` stripped; falls back to the raw string for non-URLs. */
function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return rawUrl;
  }
}

export default function HistoryPage() {
  const rows = listHistory();
  // The archive de-duplicates to one row per URL (latest run); show that count,
  // with the raw run total available on hover.
  const urlCount = new Set(rows.map((row) => row.url)).size;
  // Distinct websites — the number of collapsible sections the table renders.
  const siteCount = new Set(rows.map((row) => hostOf(row.url))).size;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="02 — Archive"
        title="History"
        description="Grouped by website into collapsible sections — open a site to see one row per URL, its latest run and the trend versus the previous run. Every run stays persisted to local SQLite and report files on disk for before/after comparison."
      >
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className="font-mono text-xs"
            title={`${siteCount} ${siteCount === 1 ? "website" : "websites"} audited`}
          >
            {siteCount} {siteCount === 1 ? "site" : "sites"}
          </Badge>
          <Badge
            variant="outline"
            className="font-mono text-xs"
            title={`${rows.length} ${rows.length === 1 ? "run" : "runs"} persisted`}
          >
            {urlCount} {urlCount === 1 ? "URL" : "URLs"}
          </Badge>
        </div>
      </PageHeader>

      <HistoryTable rows={rows} />
    </div>
  );
}
