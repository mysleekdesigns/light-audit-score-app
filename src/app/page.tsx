import { AuditConsole } from "@/components/audit/audit-console";
import { PageHeader } from "@/components/page-header";

export default function NewAuditPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="01 — Input"
        title="New Audit"
        description="Paste a list of URLs to measure their Lighthouse scores locally. Each page is audited in an isolated Chrome instance, median-of-N runs, with bounded concurrency for trustworthy numbers."
      />
      <AuditConsole />
    </div>
  );
}
