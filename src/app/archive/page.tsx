/**
 * Scheduled archive page (PRD §6 Phase 14).
 *
 * Server component that reads the local SQLite store directly (mirrors
 * `/history/page.tsx`): every persisted schedule + every persisted batch
 * (the Archive console filters batches per schedule via `scheduleId`). All
 * pause/enable/delete/run-now mutations flow through the client console
 * via Agent A's `/api/schedules/**` routes, which call `router.refresh()`
 * to re-fetch this server render.
 */

import { ArchiveConsole } from "@/components/archive/archive-console";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { listBatches } from "@/lib/db/persistence";
import { listSchedules } from "@/lib/db/schedules";

// Reads the SQLite archive at request time — must run on Node and never be
// statically prerendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function ArchivePage() {
  const schedules = listSchedules();
  const batches = listBatches();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="04 — Archive"
        title="Scheduled archive"
        description="Daily recurring audits. Each schedule fires at its HH:MM, re-resolves its target (URL list or crawl), and persists the batch alongside ad-hoc runs."
      >
        <Badge variant="outline" className="font-mono text-xs">
          {schedules.length}{" "}
          {schedules.length === 1 ? "schedule" : "schedules"}
        </Badge>
      </PageHeader>

      <ArchiveConsole schedules={schedules} batches={batches} />
    </div>
  );
}
