"use client";

/**
 * "Explain this change" — the AI hand-off inside the What Changed card
 * (ROADMAP Phase E).
 *
 * The existing analysis layer already reads a run and diagnoses it. This runs
 * the same stream with a `baselineRunId`, so the agent is handed the audit-level
 * delta and explains *the change* rather than re-diagnosing the page from
 * scratch — the highest-value thing the diff can be pointed at.
 *
 * It deliberately reuses the audit sheet's presentation components
 * (`AnalysisStatus` / `AnalysisDiagnosis` / `AnalysisFixes` / the provider
 * badge) rather than growing a second vocabulary for the same events, and it
 * shows only what THIS stream produced: it never loads a saved analysis.
 *
 * **Nothing here is cached or persisted, and the copy says so.** Saved analyses
 * are keyed `(runId, category)`, so regression-flavoured text stored under that
 * key would later replay on the run's own Analysis tab as if it were the plain
 * diagnosis of that page. A diff-grounded answer is therefore generated fresh
 * every time, and the UI must not imply otherwise.
 */

import { useId, useMemo, useState } from "react";
import { Ban, Info, RotateCw, Sparkles, TriangleAlert } from "lucide-react";

import { AnalysisDiagnosis } from "@/components/audit/analysis-diagnosis";
import { AnalysisFixes } from "@/components/audit/analysis-fixes";
import { AnalysisProviderBadge } from "@/components/audit/analysis-provider-badge";
import { AnalysisStatus } from "@/components/audit/analysis-status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAnalysisStream } from "@/hooks/useAnalysisStream";
import type { AnalysisCategory, Fix } from "@/lib/analysis/types";
import {
  analysisCategories,
  worstRegressedCategory,
} from "@/lib/compare/what-changed-view";
import type { RunDiff } from "@/lib/reports/diff-types";
import { CATEGORY_LABELS } from "@/lib/scores";

/** Mono uppercase tracking section label, matching the analysis panel. */
const SECTION_LABEL =
  "font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground";

/**
 * Terminal error codes worth naming, and which of them describe a fixable setup
 * state rather than a failure — same split (and the same reasoning) as the audit
 * sheet's analysis panel: "Ollama isn't running" is a thing to fix, not a thing
 * that broke, so it is not styled destructively.
 */
const ERROR_TITLES: Record<string, string> = {
  claude_auth_required: "Claude Code not logged in",
  provider_not_configured: "AI provider needs setup",
  provider_unavailable: "AI provider unreachable",
  rate_limited: "Rate limit reached",
};

const SOFT_ERROR_CODES = new Set(Object.keys(ERROR_TITLES));

export interface WhatChangedExplainProps {
  /** The loaded diff — supplies both run ids and the categories worth offering. */
  diff: RunDiff;
}

/**
 * Mount this keyed by the run pair (`key={`${baselineRunId}:${comparisonRunId}`}`):
 * an explanation belongs to the two runs it was generated from, so a picker
 * change should discard it rather than leave last pair's prose on screen.
 */
export function WhatChangedExplain({ diff }: WhatChangedExplainProps) {
  const baselineScores = diff.baseline.scores;
  const comparisonScores = diff.comparison.scores;

  const categories = useMemo(
    () => analysisCategories(baselineScores, comparisonScores),
    [baselineScores, comparisonScores],
  );
  // Defaults to the category that gave up the most points — the one the user is
  // almost certainly asking about. Lazily initialised so the scan runs once.
  const [category, setCategory] = useState<AnalysisCategory>(() =>
    worstRegressedCategory(baselineScores, comparisonScores),
  );

  const analysis = useAnalysisStream(diff.comparison.runId, category);
  const categoryId = useId();

  const streaming = analysis.isStreaming;
  const cancelled = analysis.status === "cancelled";
  const errored = analysis.status === "error";
  const live = streaming || cancelled;
  const result = analysis.result;
  const liveFixes = analysis.fixes.filter((fix): fix is Fix => Boolean(fix));

  function explain() {
    // `force` because a saved analysis for this (runId, category) may exist and
    // would answer the wrong question — it diagnoses the page, not the change.
    analysis.start({ baselineRunId: diff.baseline.runId, force: true });
  }

  let body: React.ReactNode;
  if (errored) {
    const code = analysis.error?.code ?? "";
    const soft = SOFT_ERROR_CODES.has(code);
    body = (
      <div className="flex flex-col gap-4">
        <Alert variant={soft ? "default" : "destructive"}>
          {soft ? <Info /> : <TriangleAlert />}
          <AlertTitle>{ERROR_TITLES[code] ?? "Analysis failed"}</AlertTitle>
          <AlertDescription>
            {analysis.error?.message ?? "Something went wrong explaining this change."}
          </AlertDescription>
        </Alert>
        <Button variant="outline" size="sm" className="self-start" onClick={explain}>
          <RotateCw data-icon="inline-start" />
          Try again
        </Button>
      </div>
    );
  } else if (live) {
    body = (
      <div className="flex flex-col gap-5">
        <AnalysisStatus
          status={analysis.status}
          statusMessage={analysis.statusMessage}
          toolEvents={analysis.toolEvents}
          busy={streaming}
        />
        {analysis.diagnosis ? (
          <>
            <Separator className="bg-border/60" />
            <section className="flex flex-col gap-3">
              <p className={SECTION_LABEL}>What changed, and why</p>
              <AnalysisDiagnosis text={analysis.diagnosis} />
            </section>
          </>
        ) : null}
        {liveFixes.length > 0 ? (
          <>
            <Separator className="bg-border/60" />
            <section className="flex flex-col gap-3">
              <p className={SECTION_LABEL}>Prioritized fixes</p>
              <AnalysisFixes fixes={liveFixes} />
            </section>
          </>
        ) : null}
      </div>
    );
  } else if (result) {
    body = (
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-3">
          <p className={SECTION_LABEL}>What changed, and why</p>
          <AnalysisDiagnosis text={result.diagnosis} />
        </section>
        <Separator className="bg-border/60" />
        <section className="flex flex-col gap-3">
          <p className={SECTION_LABEL}>Prioritized fixes</p>
          {result.fixes.length > 0 ? (
            <AnalysisFixes fixes={result.fixes} />
          ) : (
            <p className="text-xs text-muted-foreground">
              No specific fixes were returned for this change.
            </p>
          )}
        </section>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <AnalysisProviderBadge
            model={result.model}
            grounded={result.sources.length > 0}
          />
          <span className="font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground/70">
            Not saved · generated fresh
          </span>
        </div>
      </div>
    );
  } else {
    body = (
      <Empty className="rounded-md border border-dashed border-border/60 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Sparkles />
          </EmptyMedia>
          <EmptyTitle>Ask your AI what caused this</EmptyTitle>
          <EmptyDescription>
            Your configured AI reads the diff above — the audits, opportunities and requests
            that moved — and explains <em>this change</em> rather than re-diagnosing the page.
            Nothing is stored: a diff-grounded answer is generated fresh each time, and it
            never replaces the run&apos;s own saved analysis.
          </EmptyDescription>
        </EmptyHeader>
        <Button onClick={explain}>
          <Sparkles data-icon="inline-start" />
          Explain this change
        </Button>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={categoryId} className={SECTION_LABEL}>
            Category
          </label>
          <Select
            value={category}
            onValueChange={(value) => setCategory(value as AnalysisCategory)}
            disabled={streaming}
          >
            <SelectTrigger
              id={categoryId}
              size="sm"
              className="w-52 font-mono text-xs"
            >
              <SelectValue placeholder="Select a category" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {categories.map((option) => (
                  <SelectItem key={option} value={option} className="font-mono text-xs">
                    {CATEGORY_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {streaming ? (
          <Button variant="outline" size="sm" onClick={analysis.cancel}>
            <Ban data-icon="inline-start" />
            Stop
          </Button>
        ) : result || cancelled ? (
          <Button variant="ghost" size="sm" onClick={explain}>
            <RotateCw data-icon="inline-start" />
            {cancelled ? "Explain again" : "Re-explain"}
          </Button>
        ) : null}
      </div>

      {body}
    </div>
  );
}
