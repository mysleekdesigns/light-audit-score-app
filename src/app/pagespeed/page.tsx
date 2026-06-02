import { PageHeader } from "@/components/page-header";
import { PageSpeedConsole } from "@/components/pagespeed/pagespeed-console";

/**
 * PageSpeed Insights page (PSI feature). Audits run on Google's servers (no local
 * Chrome) and return lab scores plus real-world CrUX field data. `?watch=<batchId>`
 * deep-links a re-run here to stream live, mirroring the New Audit page.
 */
export default async function PageSpeedPage({
  searchParams,
}: {
  searchParams: Promise<{ watch?: string | string[] }>;
}) {
  const { watch } = await searchParams;
  const initialBatchId = Array.isArray(watch) ? watch[0] : watch;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="02 — PageSpeed"
        title="PageSpeed Insights"
        description="Audit URLs with Google's hosted Lighthouse and read real-world Core Web Vitals from the Chrome UX Report. Google runs the analysis — no local Chrome — and returns lab scores alongside field data."
      />
      <PageSpeedConsole initialBatchId={initialBatchId} />
    </div>
  );
}
