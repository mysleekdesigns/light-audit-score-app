import { PageHeader } from "@/components/page-header";
import { CompareConsole } from "@/components/compare/compare-console";
import { listHistory } from "@/lib/db/persistence";

// Reads the SQLite archive at request time — must run on Node and never be
// statically prerendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function ComparePage() {
  const rows = listHistory();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="03 — Compare"
        title="Compare & Trends"
        description="Track a URL's Lighthouse scores over time, then diff any two of its runs — score and Core Web Vitals deltas with direction."
      />

      <CompareConsole runs={rows} />
    </div>
  );
}
