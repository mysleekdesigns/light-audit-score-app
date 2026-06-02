"use client";

/**
 * Re-run / Regenerate action (PRD §6 Phase 13).
 *
 * A small reusable button that re-submits an audit through the *existing*
 * `POST /api/audits` path with a recorded `priorBatchId` (lineage), then
 * deep-links to the New-Audit page in live-watch mode (`/?watch=<batchId>`) so
 * the re-run streams in real time and stays one click from the Phase-6
 * compare / trend.
 *
 * Two presentations:
 *  - labeled ("Re-run", mono-uppercase) for the Batch summary card toolbar;
 *  - icon-only (wrapped in a Tooltip) for the dense History rows / cards.
 *
 * Pure presentational/action glue — it owns only its `submitting` flag and the
 * one POST; no other data fetching. Mirrors the toast / `ApiError` idiom from
 * `audit-console.tsx`'s `handleSubmit`.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ApiError,
  createBatch,
} from "@/lib/client/auditClient";
import type {
  AuditOptions,
  AuditSource,
  DeviceSelection,
} from "@/lib/lighthouse/types";
import { cn } from "@/lib/utils";

type ButtonProps = React.ComponentProps<typeof Button>;

export interface RerunBatchButtonProps {
  /** Exact URLs to re-run (deduped by the caller). */
  urls: string[];
  /** Device selection to reproduce (`"both"` re-fans mobile + desktop). */
  device: DeviceSelection;
  /** Exact resolved options to reproduce (categories / throttling / cpu). */
  options: AuditOptions;
  /** Resolved concurrency to reproduce. */
  concurrency: number;
  /** Match-DevTools accuracy mode, if the source batch used it. */
  accuracyMode?: boolean;
  /** Engine to reproduce ("local" | "psi"); PSI re-runs deep-link to /pagespeed. */
  source?: AuditSource;
  /** The source batch's id — recorded as lineage on the new batch. */
  priorBatchId: string;
  /** Compact icon-only button (History rows) vs labeled (Batch card). */
  iconOnly?: boolean;
  /** Pass-throughs to the underlying `Button`. */
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  disabled?: boolean;
  className?: string;
}

/** Pluralize "page" against a count (`1 page`, `3 pages`). */
function pages(count: number): string {
  return `${count} ${count === 1 ? "page" : "pages"}`;
}

export function RerunBatchButton({
  urls,
  device,
  options,
  concurrency,
  accuracyMode,
  source,
  priorBatchId,
  iconOnly = false,
  size,
  variant,
  disabled = false,
  className,
}: RerunBatchButtonProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const count = urls.length;
  const isDisabled = disabled || submitting || count === 0;
  const label = `Re-run ${pages(count)}`;

  async function handleClick() {
    setSubmitting(true);
    try {
      const created = await createBatch({
        urls,
        device,
        options,
        source,
        concurrency,
        accuracyMode,
        priorBatchId,
      });
      toast.success(`Re-running ${pages(created.jobs.length)}…`);
      // PSI re-runs stream in the PageSpeed console (field data); local in New Audit.
      const watchPath = source === "psi" ? "/pagespeed" : "/";
      router.push(`${watchPath}?watch=${encodeURIComponent(created.id)}`);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.issues[0]?.message ?? err.message
          : "Could not start the re-run.";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (iconOnly) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={variant ?? "ghost"}
            size={size ?? "icon-xs"}
            onClick={handleClick}
            disabled={isDisabled}
            aria-label={label}
            className={className}
          >
            <RefreshCw className={cn(submitting && "animate-spin")} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={variant ?? "outline"}
          size={size ?? "sm"}
          onClick={handleClick}
          disabled={isDisabled}
          aria-label={label}
          className={cn(
            "font-mono text-[0.7rem] uppercase tracking-[0.14em]",
            className,
          )}
        >
          <RefreshCw
            data-icon="inline-start"
            className={cn(submitting && "animate-spin")}
          />
          Re-run
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
