import { Skeleton } from "@/components/ui/skeleton";

const ROW_KEYS = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"] as const;

// Skeleton mirroring the History page: PageHeader + filter input + a bordered
// card containing a table of run rows.
export default function HistoryLoading() {
  return (
    <div
      className="flex flex-col gap-8"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading history…</span>

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
        <Skeleton className="h-6 w-16 rounded-full bg-card/40" />
      </div>

      {/* Filter input stand-in */}
      <Skeleton className="h-9 w-full max-w-sm bg-card/40" aria-hidden="true" />

      {/* Table card stand-in */}
      <div
        className="overflow-hidden rounded-xl border border-border/60 bg-card/40"
        aria-hidden="true"
      >
        {/* Header row */}
        <div className="flex items-center gap-4 border-b border-border/60 px-4 py-3">
          <Skeleton className="h-3 w-40 bg-muted/60" />
          <Skeleton className="ml-auto h-3 w-16 bg-muted/60" />
          <Skeleton className="h-3 w-16 bg-muted/60" />
          <Skeleton className="h-3 w-16 bg-muted/60" />
          <Skeleton className="h-3 w-16 bg-muted/60" />
        </div>
        {/* Body rows */}
        {ROW_KEYS.map((key) => (
          <div
            key={key}
            className="flex items-center gap-4 border-b border-border/60 px-4 py-3.5 last:border-b-0"
          >
            <Skeleton className="h-4 w-56 bg-muted/40" />
            <Skeleton className="ml-auto h-7 w-9 rounded-md bg-muted/40" />
            <Skeleton className="h-7 w-9 rounded-md bg-muted/40" />
            <Skeleton className="h-7 w-9 rounded-md bg-muted/40" />
            <Skeleton className="h-7 w-9 rounded-md bg-muted/40" />
          </div>
        ))}
      </div>
    </div>
  );
}
