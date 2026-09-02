/**
 * Provenance chips for a finished analysis: WHICH AI produced it, and whether it
 * was grounded in sources it actually fetched.
 *
 * Both halves are honesty devices. Every provider runs on the user's own account
 * or hardware, so "which one" is real information — a local 8B model and a
 * researching Claude agent deserve different amounts of trust. And a run that
 * cited nothing says so in plain type rather than looking identical to one that
 * did: no citations means no web research, and the badge is how the reader knows.
 *
 * Presentational and pure — the caller passes the encoded `analyses.model` value
 * and the citation count.
 */

import { Cpu, GlobeLock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { parseProviderModel, providerLabel } from "@/lib/analysis/providerModel";

export function AnalysisProviderBadge({
  /** The encoded `analyses.model` value, e.g. `"ollama/llama3.1:8b"`. */
  model,
  /** Whether the analysis carries at least one fetched source. */
  grounded,
}: {
  model: string;
  grounded: boolean;
}) {
  const parsed = parseProviderModel(model);

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge
        variant="outline"
        className="gap-1.5 border-border/70 font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground"
      >
        <Cpu className="size-3 shrink-0 text-primary" aria-hidden="true" />
        {providerLabel(parsed.provider)}
        {parsed.model ? (
          <span className="max-w-[14ch] truncate normal-case tracking-normal text-foreground/80 sm:max-w-[24ch]">
            {parsed.model}
          </span>
        ) : null}
      </Badge>

      {grounded ? null : (
        <Badge
          variant="outline"
          className="gap-1.5 border-amber-500/40 font-mono text-[0.6rem] uppercase tracking-[0.12em] text-amber-400"
        >
          <GlobeLock className="size-3 shrink-0" aria-hidden="true" />
          No web research
        </Badge>
      )}
    </span>
  );
}
