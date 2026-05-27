import { Skeleton } from "@/components/ui/skeleton";

// Skeleton mirroring the Compare page: PageHeader + URL selector + a "Score
// Trend" chart card + a "Run Diff" card.
export default function CompareLoading() {
  return (
    <div
      className="flex flex-col gap-8"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading comparison…</span>

      {/* PageHeader stand-in */}
      <div
        className="flex flex-col gap-4 border-b border-border/60 pb-6"
        aria-hidden="true"
      >
        <Skeleton className="h-3 w-28 bg-card/40" />
        <Skeleton className="h-9 w-60 bg-card/40" />
        <Skeleton className="h-4 w-full max-w-2xl bg-card/40" />
      </div>

      {/* URL selector stand-in */}
      <Skeleton className="h-9 w-full max-w-md bg-card/40" aria-hidden="true" />

      {/* Score Trend card stand-in */}
      <div
        className="rounded-xl border border-border/60 bg-card/40 p-6"
        aria-hidden="true"
      >
        <Skeleton className="h-5 w-32 bg-muted/60" />
        <Skeleton className="mt-2 h-3 w-48 bg-muted/40" />
        <Skeleton className="mt-6 h-56 w-full bg-muted/40" />
      </div>

      {/* Run Diff card stand-in */}
      <div
        className="rounded-xl border border-border/60 bg-card/40 p-6"
        aria-hidden="true"
      >
        <Skeleton className="h-5 w-28 bg-muted/60" />
        <Skeleton className="mt-2 h-3 w-52 bg-muted/40" />
        <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          <Skeleton className="h-20 w-full bg-muted/40" />
          <Skeleton className="h-20 w-full bg-muted/40" />
          <Skeleton className="h-20 w-full bg-muted/40" />
          <Skeleton className="h-20 w-full bg-muted/40" />
        </div>
      </div>
    </div>
  );
}
