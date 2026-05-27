import { Skeleton } from "@/components/ui/skeleton";

const CARD_KEYS = ["b1", "b2", "b3"] as const;

// Skeleton mirroring the Batches page: PageHeader + "Pass thresholds" panel +
// a stack of batch summary cards.
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

      {/* Pass thresholds panel stand-in */}
      <div
        className="rounded-xl border border-border/60 bg-card/40 p-6"
        aria-hidden="true"
      >
        <Skeleton className="h-4 w-32 bg-muted/60" />
        <div className="mt-4 flex flex-wrap gap-4">
          <Skeleton className="h-9 w-28 bg-muted/40" />
          <Skeleton className="h-9 w-28 bg-muted/40" />
          <Skeleton className="h-9 w-28 bg-muted/40" />
          <Skeleton className="h-9 w-28 bg-muted/40" />
        </div>
      </div>

      {/* Batch summary cards stand-in */}
      {CARD_KEYS.map((key) => (
        <div
          key={key}
          className="rounded-xl border border-border/60 bg-card/40 p-6"
          aria-hidden="true"
        >
          <div className="flex items-start justify-between">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-48 bg-muted/60" />
              <Skeleton className="h-3 w-36 bg-muted/40" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full bg-muted/40" />
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Skeleton className="h-16 w-full bg-muted/40" />
            <Skeleton className="h-16 w-full bg-muted/40" />
            <Skeleton className="h-16 w-full bg-muted/40" />
            <Skeleton className="h-16 w-full bg-muted/40" />
          </div>
        </div>
      ))}
    </div>
  );
}
