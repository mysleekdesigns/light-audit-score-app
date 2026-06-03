"use client";

/**
 * Orchestrates one category's AI analysis inside the detail sheet.
 *
 * On `(runId, category)` change it fetches any persisted analysis (shown
 * instantly, no token spend); otherwise it offers an "Analyze with Claude"
 * affordance that opens the live SSE stream (`useAnalysisStream`). It renders the
 * right surface for the current state — empty / loading / live (status + research
 * log + streaming diagnosis + incremental fixes) / result (diagnosis + fixes +
 * sources) / error (with a friendly "log in to Claude Code" path) — and exposes
 * Analyze / Re-analyze / Stop actions. Keyed by `${runId}:${category}` so it
 * remounts cleanly when the user switches device or category.
 */

import { useEffect, useState } from "react";
import { Ban, ExternalLink, Info, RotateCw, Sparkles, TriangleAlert } from "lucide-react";

import { AnalysisDiagnosis } from "@/components/audit/analysis-diagnosis";
import { AnalysisFixes } from "@/components/audit/analysis-fixes";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useAnalysisStream } from "@/hooks/useAnalysisStream";
import { getAnalysis } from "@/lib/client/auditClient";
import { CATEGORY_LABELS, formatScore, scoreColorClass } from "@/lib/scores";
import { cn } from "@/lib/utils";
import type { AnalysisCategory, AnalysisResult, Fix } from "@/lib/analysis/types";

/** Mono uppercase tracking section label, matching the house style. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
      {children}
    </p>
  );
}

/** Compact "model · time · cost" provenance line under a finished analysis. */
function AnalysisMeta({ result }: { result: AnalysisResult }) {
  const when = (() => {
    const ms = Date.parse(result.createdAt);
    return Number.isNaN(ms) ? null : new Date(ms).toLocaleString();
  })();
  const cost =
    result.costUsd !== undefined ? `$${result.costUsd.toFixed(2)}` : null;
  const parts = [result.model, when, cost].filter(Boolean) as string[];
  return (
    <p className="font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground/70">
      {parts.join(" · ")}
    </p>
  );
}

function WarningsAlert({ warnings }: { warnings: string[] }) {
  return (
    <Alert>
      <Info />
      <AlertTitle>Heads up</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function SourcesList({ result }: { result: AnalysisResult }) {
  if (result.sources.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Sources</SectionLabel>
      <ul className="flex flex-col gap-1.5">
        {result.sources.map((source, i) => (
          <li key={`${source.url}-${i}`}>
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary underline-offset-2 hover:underline"
            >
              <ExternalLink className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{source.title || source.url}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AnalysisPanel({
  runId,
  category,
  score,
}: {
  runId: string;
  category: AnalysisCategory;
  score: number | null;
}) {
  const [savedResult, setSavedResult] = useState<AnalysisResult | null>(null);
  const [loadingSaved, setLoadingSaved] = useState(true);

  const analysis = useAnalysisStream(runId, category);

  // Reset the saved-analysis state synchronously during render when the target
  // changes (React's recommended alternative to a setState-in-effect, and what
  // the lint rule enforces). The effect below only sets state in async callbacks.
  const key = `${runId}:${category}`;
  const [trackedKey, setTrackedKey] = useState(key);
  if (key !== trackedKey) {
    setTrackedKey(key);
    setSavedResult(null);
    setLoadingSaved(true);
  }

  // Load any persisted analysis when the target changes (no token spend). Guarded
  // against StrictMode double-effects + out-of-order responses with `active`.
  useEffect(() => {
    let active = true;
    getAnalysis(runId, category)
      .then((result) => {
        if (active) setSavedResult(result);
      })
      .catch(() => {
        // A failed lookup just means "no saved analysis to show" — the user can run one.
      })
      .finally(() => {
        if (active) setLoadingSaved(false);
      });
    return () => {
      active = false;
    };
  }, [runId, category]);

  const streaming = analysis.isStreaming;
  const errored = analysis.status === "error";
  const cancelled = analysis.status === "cancelled";
  const live = streaming || cancelled;
  const displayResult = analysis.result ?? savedResult;
  const liveFixes = analysis.fixes.filter((f): f is Fix => Boolean(f));

  const headerAction = streaming ? (
    <Button variant="outline" size="sm" onClick={analysis.cancel}>
      <Ban data-icon="inline-start" />
      Stop
    </Button>
  ) : displayResult ? (
    <Button variant="ghost" size="sm" onClick={() => analysis.start({ force: true })}>
      <RotateCw data-icon="inline-start" />
      Re-analyze
    </Button>
  ) : cancelled ? (
    <Button variant="outline" size="sm" onClick={() => analysis.start()}>
      <Sparkles data-icon="inline-start" />
      Analyze again
    </Button>
  ) : null;

  let body: React.ReactNode;
  if (errored) {
    const isAuth = analysis.error?.code === "claude_auth_required";
    body = (
      <div className="flex flex-col gap-4">
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>
            {isAuth ? "Claude Code not logged in" : "Analysis failed"}
          </AlertTitle>
          <AlertDescription>
            {analysis.error?.message ?? "Something went wrong running the analysis."}
          </AlertDescription>
        </Alert>
        <Button variant="outline" size="sm" className="self-start" onClick={() => analysis.start()}>
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
              <SectionLabel>Diagnosis</SectionLabel>
              <AnalysisDiagnosis text={analysis.diagnosis} />
            </section>
          </>
        ) : null}
        {liveFixes.length > 0 ? (
          <>
            <Separator className="bg-border/60" />
            <section className="flex flex-col gap-3">
              <SectionLabel>Prioritized fixes</SectionLabel>
              <AnalysisFixes fixes={liveFixes} />
            </section>
          </>
        ) : null}
      </div>
    );
  } else if (displayResult) {
    body = (
      <div className="flex flex-col gap-5">
        {displayResult.warnings && displayResult.warnings.length > 0 ? (
          <WarningsAlert warnings={displayResult.warnings} />
        ) : null}
        <section className="flex flex-col gap-3">
          <SectionLabel>Diagnosis</SectionLabel>
          <AnalysisDiagnosis text={displayResult.diagnosis} />
        </section>
        <Separator className="bg-border/60" />
        <section className="flex flex-col gap-3">
          <SectionLabel>Prioritized fixes</SectionLabel>
          {displayResult.fixes.length > 0 ? (
            <AnalysisFixes fixes={displayResult.fixes} />
          ) : (
            <p className="text-xs text-muted-foreground">
              No specific fixes were returned for this category.
            </p>
          )}
        </section>
        {displayResult.sources.length > 0 ? (
          <>
            <Separator className="bg-border/60" />
            <SourcesList result={displayResult} />
          </>
        ) : null}
      </div>
    );
  } else if (loadingSaved) {
    body = (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  } else {
    body = (
      <Empty className="border border-dashed border-border/60 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Sparkles />
          </EmptyMedia>
          <EmptyTitle>Ask Claude why this score is low</EmptyTitle>
          <EmptyDescription>
            Claude reads the audit data, researches fixes on the web with CrawlForge,
            and returns prioritized, source-cited recommendations.
          </EmptyDescription>
        </EmptyHeader>
        <Button onClick={() => analysis.start()}>
          <Sparkles data-icon="inline-start" />
          Analyze with Claude
        </Button>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "font-mono text-2xl font-semibold tabular-nums tracking-tight",
              scoreColorClass(score),
            )}
          >
            {formatScore(score)}
          </span>
          <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
            {CATEGORY_LABELS[category]}
          </span>
        </div>
        {headerAction}
      </div>

      <ScrollArea className="min-h-0 flex-1 overscroll-contain">
        <div className="p-4">{body}</div>
      </ScrollArea>

      {displayResult && !live ? (
        <div className="border-t border-border/60 px-4 py-2">
          <AnalysisMeta result={displayResult} />
        </div>
      ) : null}
    </div>
  );
}
