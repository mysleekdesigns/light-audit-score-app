import { AuditConsole } from "@/components/audit/audit-console";
import { PageHeader } from "@/components/page-header";

/**
 * `?watch=<batchId>` (PRD §6 Phase 13) deep-links a re-run here to stream live.
 * Reading searchParams opts this page into dynamic rendering, which is correct —
 * the audit console is fully client-driven.
 */
export default async function NewAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ watch?: string | string[] }>;
}) {
  const { watch } = await searchParams;
  const initialBatchId = Array.isArray(watch) ? watch[0] : watch;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="01 — Input"
        title="Lighthouse"
        description="Paste a list of URLs to measure their Lighthouse scores locally. Each page is audited in an isolated Chrome instance, median-of-N runs, with bounded concurrency for trustworthy numbers."
      />
      <AuditConsole initialBatchId={initialBatchId} />
    </div>
  );
}
