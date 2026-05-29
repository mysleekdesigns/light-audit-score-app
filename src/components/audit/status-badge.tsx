import { Ban, Check, Clock, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import type { JobStatus } from "@/lib/queue/types";

interface JobStatusBadgeProps {
  status: JobStatus;
  className?: string;
}

/**
 * A small status pill for a per-URL audit job. Maps each {@link JobStatus} to a
 * Badge variant, a leading lucide icon (or a Spinner while running) and a mono
 * uppercase label, matching the project's telemetry-console aesthetic. Pure
 * presentational.
 */
export function JobStatusBadge({ status, className }: JobStatusBadgeProps) {
  const baseClass = cn(
    "gap-1.5 font-mono text-[0.625rem] uppercase tracking-[0.18em]",
    className
  );

  switch (status) {
    case "queued":
      return (
        <Badge variant="secondary" className={baseClass}>
          <Clock data-icon="inline-start" />
          Queued
        </Badge>
      );
    case "running":
      return (
        <Badge className={baseClass}>
          <Spinner data-icon="inline-start" />
          Running
        </Badge>
      );
    case "done":
      return (
        <Badge variant="outline" className={cn(baseClass, "border-score-good/40 text-score-good")}>
          <Check data-icon="inline-start" />
          Done
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive" className={baseClass}>
          <TriangleAlert data-icon="inline-start" />
          Error
        </Badge>
      );
    case "cancelled":
      return (
        <Badge
          variant="outline"
          className={cn(baseClass, "border-border/60 text-muted-foreground")}
        >
          <Ban data-icon="inline-start" />
          Cancelled
        </Badge>
      );
  }
}
