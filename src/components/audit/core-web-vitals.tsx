import { cn } from "@/lib/utils";
import { METRIC_DISPLAY_ORDER, METRIC_META, scoreColorClass } from "@/lib/scores";
import type { CoreWebVitals } from "@/lib/lighthouse/types";

interface CoreWebVitalsStripProps {
  /** Metric id → value, keyed by audit id; a value may be null when absent. */
  metrics: CoreWebVitals;
  className?: string;
}

/**
 * A compact, responsive strip of the six key timing metrics in PRD display order
 * (LCP, CLS, TBT, FCP, SI, TTI). Each cell shows the metric abbreviation as a
 * mono caption and the human-readable value, band-coloured from the metric's
 * 0–1 score (scaled to 0–100). Missing metrics render an em dash. Pure
 * presentational; the metric label is exposed via a native `title` tooltip.
 */
export function CoreWebVitalsStrip({ metrics, className }: CoreWebVitalsStripProps) {
  return (
    <dl
      className={cn(
        "grid grid-cols-3 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-6",
        className
      )}
    >
      {METRIC_DISPLAY_ORDER.map((id) => {
        const metric = metrics[id];
        const meta = METRIC_META[id];
        const hasValue = metric != null;
        // Metric `score` is 0–1; scale to 0–100 for the shared band helper.
        const colorClass = scoreColorClass(
          metric?.score == null ? null : metric.score * 100
        );

        return (
          <div
            key={id}
            title={meta.label}
            className="flex flex-col gap-1 bg-card px-3 py-2.5"
          >
            <dt className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground">
              {meta.abbr}
            </dt>
            <dd
              className={cn(
                "font-mono text-sm font-medium tabular-nums",
                hasValue ? colorClass : "text-muted-foreground"
              )}
            >
              {metric?.displayValue ?? "—"}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
