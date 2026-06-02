/**
 * Real-world CrUX field-data panel — the headline value PageSpeed Insights adds
 * over the local engine. Renders URL-level and origin-level loading experiences
 * (whichever CrUX has data for), each with an overall Core Web Vitals assessment
 * and a per-metric distribution. Degrades to an empty state when CrUX has
 * insufficient data (low-traffic URLs). Pure presentational.
 */

import { UsersRound } from "lucide-react";

import {
  FieldAssessmentChip,
  FieldMetricBar,
} from "@/components/pagespeed/field-metric-bar";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { FieldData, FieldExperience } from "@/lib/lighthouse/types";
import { FIELD_METRIC_DISPLAY_ORDER } from "@/lib/pagespeed/field-metrics";

function FieldExperienceBlock({
  label,
  experience,
}: {
  label: string;
  experience: FieldExperience;
}) {
  const metricIds = FIELD_METRIC_DISPLAY_ORDER.filter(
    (id) => experience.metrics[id],
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
          {label}
        </span>
        <FieldAssessmentChip category={experience.overallCategory} />
      </div>
      {metricIds.length > 0 ? (
        <div className="flex flex-col gap-3">
          {metricIds.map((id) => (
            <FieldMetricBar key={id} id={id} metric={experience.metrics[id]!} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No individual metrics met the CrUX data threshold for this scope.
        </p>
      )}
    </div>
  );
}

export function FieldDataPanel({ field }: { field?: FieldData }) {
  const blocks = [
    { key: "url", label: "This URL", experience: field?.url },
    { key: "origin", label: "Origin · all pages", experience: field?.origin },
  ].filter(
    (b): b is { key: string; label: string; experience: FieldExperience } =>
      b.experience !== undefined,
  );

  if (blocks.length === 0) {
    return (
      <Empty className="border border-border/60 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersRound />
          </EmptyMedia>
          <EmptyTitle>No real-world field data</EmptyTitle>
          <EmptyDescription>
            The Chrome UX Report has insufficient real-user data for this URL or
            origin. Lab scores above still reflect Google&apos;s hosted run.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {blocks.map(({ key, label, experience }) => (
        <FieldExperienceBlock key={key} label={label} experience={experience} />
      ))}
      <p className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground/70">
        Real users · Chrome UX Report · trailing 28 days
      </p>
    </div>
  );
}
