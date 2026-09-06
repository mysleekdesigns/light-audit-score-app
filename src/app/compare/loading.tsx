import { Skeleton } from "@/components/ui/skeleton";

// Skeleton mirroring the Compare page: PageHeader, then the same grid the real
// console uses — one column to `xl`, and from there Target URL over Score Trend
// on the left with Run Diff beside both, and What Changed spanning both columns
// beneath them. A stand-in on the wrong breakpoint would reflow the whole page
// the moment data landed.
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

      <div
        className="grid gap-6 xl:grid-cols-2 xl:items-start"
        aria-hidden="true"
      >
        <div className="flex flex-col gap-6">
          {/* Target URL band stand-in */}
          <div className="flex flex-col gap-4 rounded-xl bg-card/40 px-4 py-4">
            <Skeleton className="h-5 w-28 bg-muted/60" />
            <div className="flex flex-col gap-4 rounded-lg bg-muted/20 p-3">
              <Skeleton className="h-8 w-full bg-muted/40" />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-9 w-full bg-muted/40" />
                ))}
              </div>
            </div>
          </div>

          {/* Score Trend card stand-in */}
          <div className="flex flex-col gap-4 rounded-xl bg-card/40 px-4 py-4">
            <Skeleton className="h-4 w-32 bg-muted/60" />
            <Skeleton className="h-3 w-40 bg-muted/40" />
            <Skeleton className="h-52 w-full bg-muted/40 sm:h-64" />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full bg-muted/40" />
              ))}
            </div>
          </div>
        </div>

        {/* Run Diff card stand-in */}
        <div className="flex flex-col gap-4 rounded-xl bg-card/40 px-4 py-4">
          <Skeleton className="h-4 w-28 bg-muted/60" />
          <Skeleton className="h-3 w-52 bg-muted/40" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-8 w-full bg-muted/40" />
            <Skeleton className="h-8 w-full bg-muted/40" />
          </div>
          <Skeleton className="h-40 w-full bg-muted/40" />
          <Skeleton className="h-56 w-full bg-muted/40" />
          <Skeleton className="h-28 w-full bg-muted/40" />
        </div>

        {/* What Changed card stand-in. It renders closed by default — an
            explanation plus one button — so the stand-in is short rather than
            reserving room for tables nobody has asked for yet. */}
        <div className="flex flex-col gap-4 rounded-xl bg-card/40 px-4 py-4 xl:col-span-2">
          <Skeleton className="h-4 w-36 bg-muted/60" />
          <Skeleton className="h-3 w-full max-w-xl bg-muted/40" />
          <Skeleton className="h-32 w-full bg-muted/40" />
        </div>
      </div>
    </div>
  );
}
