import { Skeleton } from "@/components/ui/skeleton";

const CARD_KEYS = ["c1", "c2", "c3"] as const;

// Skeleton mirroring the Archive page: PageHeader + a stack of schedule cards
// (each: header row · cadence telemetry · run-history strip).
export default function ArchiveLoading() {
  return (
    <div
      className="flex flex-col gap-8"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading scheduled archive…</span>

      {/* PageHeader stand-in (kicker / title / description + badge) */}
      <div
        className="flex flex-col gap-4 border-b border-border/60 pb-6 md:flex-row md:items-end md:justify-between"
        aria-hidden="true"
      >
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-28 bg-card/40" />
          <Skeleton className="h-9 w-44 bg-card/40" />
          <Skeleton className="h-4 w-full max-w-2xl bg-card/40" />
        </div>
        <Skeleton className="h-6 w-20 rounded-full bg-card/40" />
      </div>

      {/* Schedule cards stand-in */}
      <div className="flex flex-col gap-4" aria-hidden="true">
        {CARD_KEYS.map((key) => (
          <div
            key={key}
            className="overflow-hidden rounded-xl border border-border/60 bg-card/40"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-44 bg-muted/50" />
                <Skeleton className="h-3 w-64 bg-muted/30" />
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-14 rounded-md bg-muted/40" />
                <Skeleton className="h-8 w-20 rounded-md bg-muted/40" />
                <Skeleton className="h-8 w-16 rounded-md bg-muted/40" />
              </div>
            </div>
            <div className="grid gap-4 px-5 py-4 sm:grid-cols-4">
              <Skeleton className="h-10 w-full bg-muted/30" />
              <Skeleton className="h-10 w-full bg-muted/30" />
              <Skeleton className="h-10 w-full bg-muted/30" />
              <Skeleton className="h-10 w-full bg-muted/30" />
            </div>
            <div className="border-t border-border/60 px-5 py-4">
              <Skeleton className="h-3 w-32 bg-muted/40" />
              <div className="mt-3 flex items-center gap-2">
                <Skeleton className="h-8 w-16 rounded-md bg-muted/30" />
                <Skeleton className="h-8 w-16 rounded-md bg-muted/30" />
                <Skeleton className="h-8 w-16 rounded-md bg-muted/30" />
                <Skeleton className="h-8 w-16 rounded-md bg-muted/30" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
