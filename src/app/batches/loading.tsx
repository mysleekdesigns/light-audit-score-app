import { Skeleton } from "@/components/ui/skeleton";

const CARD_KEYS = ["b1", "b2", "b3"] as const;
const DIAL_KEYS = ["d1", "d2", "d3", "d4"] as const;

// Skeleton mirroring the Batches page: PageHeader + the "Pass thresholds"
// console (dial grid + readout bezel) + a stack of batch summary cards, each
// ending in its own footer bezel. Mobile-first, matching the live layout's
// container-query steps so nothing jumps when the real page swaps in.
export default function BatchesLoading() {
  return (
    <div
      className="flex flex-col gap-8"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading batches…</span>

      {/* PageHeader stand-in (kicker / title / description + badge) */}
      <div
        className="flex flex-col gap-4 border-b border-border/60 pb-6 md:flex-row md:items-end md:justify-between"
        aria-hidden="true"
      >
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-28 bg-card/40" />
          <Skeleton className="h-9 w-56 bg-card/40" />
          <Skeleton className="h-4 w-full max-w-2xl bg-card/40" />
        </div>
        <Skeleton className="h-6 w-20 rounded-full bg-card/40" />
      </div>

      <div className="flex flex-col gap-6">
        {/* Pass thresholds console stand-in */}
        <div
          className="@container rounded-xl bg-card px-4 py-4 ring-1 ring-foreground/10"
          aria-hidden="true"
        >
          <div className="flex items-baseline justify-between gap-4">
            <Skeleton className="h-5 w-36 bg-muted/60" />
            <Skeleton className="h-3 w-28 bg-muted/40" />
          </div>
          <div className="mt-4 grid gap-4 @3xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] @3xl:items-start @3xl:gap-6">
            <div className="grid grid-cols-2 gap-3 @sm:grid-cols-4">
              {DIAL_KEYS.map((key) => (
                <div key={key} className="flex flex-col gap-2">
                  <Skeleton className="h-2.5 w-10 bg-muted/40" />
                  <Skeleton className="h-8 w-full bg-muted/40" />
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-3">
              <div className="grid grid-cols-2 gap-3 @sm:flex @sm:gap-6">
                <Skeleton className="h-9 w-24 bg-muted/40" />
                <Skeleton className="h-9 w-24 bg-muted/40" />
              </div>
              <Skeleton className="h-6 w-full bg-muted/40" />
              <Skeleton className="h-7 w-full bg-muted/40 @sm:w-28" />
            </div>
          </div>
        </div>

        {/* Batch summary cards stand-in */}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 2xl:grid-cols-3">
          {CARD_KEYS.map((key) => (
            <div
              key={key}
              className="@container flex flex-col gap-4 rounded-xl bg-card py-4 ring-1 ring-foreground/10"
              aria-hidden="true"
            >
              <div className="flex flex-col gap-3 border-b border-border/60 px-4 pb-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Skeleton className="h-4 w-20 bg-muted/60" />
                  <Skeleton className="h-5 w-24 rounded-full bg-muted/40" />
                  <Skeleton className="h-3 w-36 bg-muted/40 @sm:ml-auto" />
                </div>
                <Skeleton className="h-3 w-48 bg-muted/40" />
              </div>

              <div className="flex flex-col gap-5 px-4">
                <div className="grid grid-cols-2 gap-x-2 gap-y-4 @xs:grid-cols-4">
                  {DIAL_KEYS.map((dial) => (
                    <div
                      key={dial}
                      className="flex flex-col items-center gap-1.5"
                    >
                      <Skeleton className="size-15 rounded-full bg-muted/40" />
                      <Skeleton className="h-2.5 w-10 bg-muted/40" />
                    </div>
                  ))}
                </div>
                <div className="grid gap-3 @lg:grid-cols-2">
                  <Skeleton className="h-16 w-full bg-muted/40" />
                  <Skeleton className="h-16 w-full bg-muted/40" />
                </div>
                <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
                  {DIAL_KEYS.map((tile) => (
                    <Skeleton key={tile} className="h-16 w-full bg-muted/40" />
                  ))}
                </div>
                <Skeleton className="h-32 w-full bg-muted/40 @3xl:h-24" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
