import { Skeleton } from "@/components/ui/skeleton";

// Skeleton mirroring the Compare page: PageHeader + the Target URL band + the
// Score Trend / Run Diff pair, which stack to `xl` and split there exactly as
// the real console does — a stand-in on the wrong breakpoint would reflow the
// whole page the moment data landed.
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

      <div className="flex flex-col gap-6" aria-hidden="true">
        {/* Target URL band stand-in */}
        <div className="flex flex-col gap-4 rounded-xl bg-card/40 px-4 py-4">
          <Skeleton className="h-5 w-28 bg-muted/60" />
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <Skeleton className="h-8 w-full bg-muted/40 lg:max-w-2xl" />
            <div className="grid w-full grid-cols-2 gap-3 rounded-lg bg-muted/20 p-3 sm:flex sm:w-auto sm:gap-6">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-9 w-full bg-muted/40 sm:w-24" />
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-2 xl:items-start">
          {/* Score Trend card stand-in */}
          <div className="flex flex-col gap-4 rounded-xl bg-card/40 px-4 py-4">
            <Skeleton className="h-4 w-32 bg-muted/60" />
            <Skeleton className="h-3 w-40 bg-muted/40" />
            <Skeleton className="h-52 w-full bg-muted/40 lg:h-64" />
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full bg-muted/40" />
              ))}
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
          </div>
        </div>
      </div>
    </div>
  );
}
