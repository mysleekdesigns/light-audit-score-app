import { Skeleton } from "@/components/ui/skeleton";

// Root Suspense fallback — shown during navigations and initial compile.
// Mirrors the generic page shell (PageHeader + a content card) so the layout
// stays stable when real content streams in.
export default function RootLoading() {
  return (
    <div
      className="flex flex-col gap-8"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading…</span>

      {/* PageHeader stand-in */}
      <div
        className="flex flex-col gap-4 border-b border-border/60 pb-6"
        aria-hidden="true"
      >
        <Skeleton className="h-3 w-24 bg-card/40" />
        <Skeleton className="h-9 w-56 bg-card/40" />
        <Skeleton className="h-4 w-full max-w-2xl bg-card/40" />
      </div>

      {/* Content stand-in */}
      <div
        className="rounded-xl border border-border/60 bg-card/40 p-6"
        aria-hidden="true"
      >
        <div className="flex flex-col gap-4">
          <Skeleton className="h-5 w-40 bg-muted/60" />
          <Skeleton className="h-32 w-full bg-muted/40" />
        </div>
      </div>
    </div>
  );
}
