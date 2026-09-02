"use client";

/**
 * The prioritized, web-researched fixes list. Mirrors the layout vocabulary of
 * `OpportunitiesPanel` (bordered, divided rows; balanced titles; muted secondary
 * text) so it sits naturally alongside the rest of the detail sheet. Each fix
 * carries a priority chip, a "why", concrete steps, and one or more cited source
 * links (the grounding the agent fetched via the research MCP server).
 */

import { ExternalLink } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AnalysisCitation, Fix, FixPriority } from "@/lib/analysis/types";

const PRIORITY_LABEL: Record<FixPriority, string> = {
  high: "High",
  medium: "Med",
  low: "Low",
};

/** Priority chip tint — reuses the score colour tokens (red = most urgent). */
const PRIORITY_CLASS: Record<FixPriority, string> = {
  high: "text-score-poor bg-score-poor/10 border-score-poor/30",
  medium: "text-score-average bg-score-average/10 border-score-average/30",
  low: "text-muted-foreground bg-muted/40 border-border/60",
};

/** Display the source's hostname (sans `www.`), full URL in the title attribute. */
function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Citations({ citations }: { citations: AnalysisCitation[] }) {
  if (citations.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
      {citations.map((citation, idx) => (
        <a
          key={`${citation.url}-${idx}`}
          href={citation.url}
          target="_blank"
          rel="noopener noreferrer"
          title={citation.title ? `${citation.title} — ${citation.url}` : citation.url}
          className="inline-flex items-center gap-1 font-mono text-[0.7rem] text-primary underline-offset-2 hover:underline"
        >
          <ExternalLink className="size-3 shrink-0" aria-hidden />
          {hostname(citation.url)}
        </a>
      ))}
    </div>
  );
}

export function AnalysisFixes({ fixes }: { fixes: Fix[] }) {
  if (fixes.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      <ul className="flex flex-col divide-y divide-border/50">
        {fixes.map((fix, index) => (
          <li key={index} className="flex flex-col gap-2 px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-sm font-medium leading-snug text-balance text-foreground">
                {fix.title}
              </p>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-[0.12em]",
                  PRIORITY_CLASS[fix.priority],
                )}
              >
                {PRIORITY_LABEL[fix.priority]}
              </span>
            </div>

            {fix.why ? (
              <p className="text-xs leading-relaxed text-muted-foreground">{fix.why}</p>
            ) : null}

            {fix.steps.length > 0 ? (
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-xs leading-relaxed text-foreground/80 marker:font-mono marker:text-muted-foreground">
                {fix.steps.map((step, idx) => (
                  <li key={idx} className="pl-1">
                    {step}
                  </li>
                ))}
              </ol>
            ) : null}

            <Citations citations={fix.citations} />
          </li>
        ))}
      </ul>
    </div>
  );
}
