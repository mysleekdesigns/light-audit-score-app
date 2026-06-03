"use client";

/**
 * The live "what's the agent doing" surface: a mono status line plus an
 * append-only research log of CrawlForge tool calls (each a chip that flips from
 * a spinner to a check/cross when its result lands). Announced via `aria-live`
 * so screen-reader users hear research progress without losing focus.
 */

import { Check, Globe, Search, X } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { AnalysisStatus, ToolEvent } from "@/hooks/useAnalysisStream";

const STATUS_LABEL: Record<AnalysisStatus, string> = {
  idle: "",
  connecting: "Connecting",
  diagnosing: "Reading audit data",
  researching: "Researching the web",
  writing: "Writing diagnosis",
  finalizing: "Finishing up",
  done: "Complete",
  error: "Error",
  cancelled: "Cancelled",
};

export function AnalysisStatus({
  status,
  statusMessage,
  toolEvents,
  busy,
}: {
  status: AnalysisStatus;
  statusMessage: string | null;
  toolEvents: ToolEvent[];
  /** Whether a spinner should accompany the status line. */
  busy: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2" aria-live="polite">
        {busy ? <Spinner className="size-3.5 text-primary" /> : null}
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
          {STATUS_LABEL[status]}
        </span>
        {statusMessage ? (
          <span className="truncate text-xs text-muted-foreground/80">
            {statusMessage}
          </span>
        ) : null}
      </div>

      {toolEvents.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-live="polite">
          {toolEvents.map((event) => {
            const Lead = event.label.startsWith("Reading") ? Globe : Search;
            return (
              <li
                key={event.id}
                className="flex items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 py-1.5"
              >
                <Lead className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/80">
                  {event.label}
                </span>
                {!event.done ? (
                  <Spinner className="size-3 shrink-0 text-muted-foreground" />
                ) : event.ok ? (
                  <Check className="size-3.5 shrink-0 text-score-good" aria-label="Done" />
                ) : (
                  <X className={cn("size-3.5 shrink-0 text-score-poor")} aria-label="Failed" />
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
