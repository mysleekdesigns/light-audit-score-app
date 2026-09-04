"use client";

/**
 * Orchestrates one category's AI analysis inside the detail sheet.
 *
 * On `(runId, category)` change it fetches any persisted analysis (shown
 * instantly, no token spend); otherwise it offers an "Analyze with <provider>"
 * affordance that opens the live SSE stream (`useAnalysisStream`). It renders the
 * right surface for the current state — empty / loading / live (status + research
 * log + streaming diagnosis + incremental fixes) / result (diagnosis + fixes +
 * sources) / error (with friendly setup + retry paths) — and exposes
 * Analyze / Re-analyze / Stop actions. Keyed by `${runId}:${category}` so it
 * remounts cleanly when the user switches device or category.
 *
 * It reads the resolved AI provider purely to be HONEST about it: to name the
 * provider on the button, to say up front when it can't do web research, and to
 * turn "no AI configured" into an explanation instead of an error. The stream
 * itself is provider-agnostic — every driver emits the same events.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Ban,
  Cpu,
  ExternalLink,
  Info,
  RotateCw,
  Settings2,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useAnalysisStream } from "@/hooks/useAnalysisStream";
import { getAiProviderStatus } from "@/lib/client/aiProvider";
import { getAnalysis } from "@/lib/client/auditClient";
import type { AiProviderStatus } from "@/lib/analysis/providerStatus";
import { safeHttpHref } from "@/lib/redactUrl";
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

/**
 * Provenance footer for a finished analysis: which AI produced it, whether it
 * was grounded in fetched sources, and when (plus cost, when the driver knows).
 */
function AnalysisMeta({ result }: { result: AnalysisResult }) {
  const when = (() => {
    const ms = Date.parse(result.createdAt);
    return Number.isNaN(ms) ? null : new Date(ms).toLocaleString();
  })();
  const cost =
    result.costUsd !== undefined ? `$${result.costUsd.toFixed(2)}` : null;
  const parts = [when, cost].filter(Boolean) as string[];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <AnalysisProviderBadge
        model={result.model}
        grounded={result.sources.length > 0}
      />
      {parts.length > 0 ? (
        <span className="font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground/70">
          {parts.join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Titles for the terminal error codes worth naming. Everything else falls back
 * to "Analysis failed" — and the three setup/retry states below are NOT styled
 * destructively, because "Ollama isn't running" or "you hit your own plan limit"
 * is a thing to fix, not a thing that broke.
 */
const ERROR_TITLES: Record<string, string> = {
  claude_auth_required: "Claude Code not logged in",
  provider_not_configured: "AI provider needs setup",
  provider_unavailable: "AI provider unreachable",
  rate_limited: "Rate limit reached",
};

/** Codes that describe a fixable setup / retry state rather than a failure. */
const SOFT_ERROR_CODES = new Set([
  "claude_auth_required",
  "provider_not_configured",
  "provider_unavailable",
  "rate_limited",
]);

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
  // Same check the fixes list makes: these URLs are model output, and an
  // analysis persisted before `parseFixes` validated them may still hold one
  // that isn't http(s). See `safeHttpHref`.
  const sources = result.sources.flatMap((source) => {
    const url = safeHttpHref(source.url);
    return url ? [{ ...source, url }] : [];
  });
  if (sources.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Sources</SectionLabel>
      <ul className="flex flex-col gap-1.5">
        {sources.map((source, i) => (
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
  const [providerStatus, setProviderStatus] = useState<AiProviderStatus | null>(null);

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

  // Which AI is configured, so the empty state names it honestly. `probe: false`
  // skips Ollama detection — the panel only needs the resolved provider, and the
  // sheet shouldn't wait on a localhost round-trip to render. Failure is fine:
  // `null` just means generic copy.
  useEffect(() => {
    const ac = new AbortController();
    void getAiProviderStatus({ probe: false, signal: ac.signal }).then((value) => {
      if (!ac.signal.aborted && value) setProviderStatus(value);
    });
    return () => ac.abort();
  }, []);

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
    const code = analysis.error?.code ?? "";
    const soft = SOFT_ERROR_CODES.has(code);
    body = (
      <div className="flex flex-col gap-4">
        <Alert variant={soft ? "default" : "destructive"}>
          {soft ? <Info /> : <TriangleAlert />}
          <AlertTitle>{ERROR_TITLES[code] ?? "Analysis failed"}</AlertTitle>
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
  } else if (providerStatus?.missing) {
    // Not an error: no AI configured yet is a normal state, so explain the
    // options rather than showing a red banner for something nobody broke.
    body = (
      <Empty className="border border-dashed border-border/60 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Cpu />
          </EmptyMedia>
          <EmptyTitle>Bring your own AI</EmptyTitle>
          <EmptyDescription>
            Analysis runs on your own AI — the Claude you&apos;re already signed in
            to, a model running locally under Ollama, or any OpenAI-compatible
            endpoint you have a key for. {providerStatus.missing}
          </EmptyDescription>
        </EmptyHeader>
        <Button asChild variant="outline">
          <Link href="/settings">
            <Settings2 data-icon="inline-start" />
            Set up a provider
          </Link>
        </Button>
      </Empty>
    );
  } else {
    const label = providerStatus?.label ?? "AI";
    // Research takes both halves — a provider that supports it and a server to
    // drive — so promise citations only when both are actually in place. Until
    // the status lands (or if it never does) claim NEITHER: an over-promise and a
    // premature "ungrounded" are both wrong, and this state is momentary.
    const grounded = providerStatus
      ? providerStatus.canWebResearch && providerStatus.researchConfigured
      : null;
    const description =
      grounded === null
        ? `${label} reads the audit data and returns prioritized, high-impact fixes.`
        : grounded
          ? `${label} reads the audit data, researches fixes on the web, and returns prioritized, source-cited recommendations.`
          : `${label} reads the audit data and returns prioritized fixes. Because ${
              providerStatus?.canWebResearch
                ? "no research server is configured"
                : "it can't browse"
            }, this diagnosis is ungrounded — no web research and no citations.`;
    body = (
      <Empty className="border border-dashed border-border/60 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Sparkles />
          </EmptyMedia>
          <EmptyTitle>Ask {label} why this score is low</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <Button onClick={() => analysis.start()}>
          <Sparkles data-icon="inline-start" />
          Analyze with {label}
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
