"use client";

/**
 * AI analysis provider status.
 *
 * AI analysis runs on YOUR AI — a Claude Code / Max login, a provider key you
 * own, or a model running locally under Ollama. LightAudit ships no AI
 * credential of its own, so like the PageSpeed panel this is read-only status
 * plus guidance: the selection lives in the environment (a gitignored `.env`),
 * and nothing here is stored or written by the app.
 *
 * `GET /api/settings/ai-provider` resolves exactly what the analysis engine
 * resolves — so "Ready" here means an analysis really will run — and probes for
 * a local Ollama, which is the one thing the user cannot easily look up: which
 * models they have already pulled.
 */

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import {
  CheckCircle2,
  Cpu,
  GlobeLock,
  HardDrive,
  Loader2,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { getAiProviderStatus } from "@/lib/client/aiProvider";
import type { AiProviderStatus, OllamaModel } from "@/lib/analysis/providerStatus";
import { cn } from "@/lib/utils";

/** A mono key/value row in the resolved-provider readout. */
function Readout({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate font-mono text-xs text-foreground">{value}</dd>
    </div>
  );
}

/** The `.env` lines that would select this provider, ready to copy. */
function EnvSnippet({ lines }: { lines: string[] }) {
  return (
    <code className="block overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre text-foreground">
      {lines.join("\n")}
    </code>
  );
}

export function AiProviderSettings() {
  const [status, setStatus] = useState<AiProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // Pure read — no setState, so it's safe to call synchronously from an effect.
  const fetchStatus = useCallback(() => getAiProviderStatus({ probe: true }), []);

  // State is applied in an effect-event, keeping setState out of reactive effect
  // scope — the codebase's mount-fetch pattern.
  const applyStatus = useEffectEvent((value: AiProviderStatus | null) => {
    setStatus(value);
    setLoading(false);
  });
  useEffect(() => {
    let active = true;
    void fetchStatus().then((value) => {
      if (active) applyStatus(value);
    });
    return () => {
      active = false;
    };
  }, [fetchStatus]);

  const ready = status !== null && status.missing === null;
  const ollama = status?.ollama;

  // Suggest the beefiest installed model rather than whatever sorts first —
  // on-disk size tracks capability closely enough, and a bigger local model
  // reasons about a full audit noticeably better.
  const suggestedModel =
    ollama?.models.reduce<OllamaModel | null>(
      (best, model) =>
        (model.sizeBytes ?? 0) > (best?.sizeBytes ?? 0) ? model : best,
      null,
    )?.name ?? "qwen2.5-coder:14b";

  return (
    <section className="rounded-lg border border-border/60 bg-card/40">
      {/* instrument header strip */}
      <header className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-md border border-border/70 bg-background/60 text-primary">
            <Cpu className="size-4" aria-hidden="true" />
          </span>
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              AI analysis provider
            </h2>
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
              Claude · Ollama · custom
            </span>
          </div>
        </div>
        <StatusPill loading={loading} status={status} />
      </header>

      <div className="flex flex-col gap-5 px-5 py-5">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Score analysis runs on <em className="not-italic text-foreground">your</em>{" "}
          AI, never ours: the Claude you are already signed in to, a model running
          locally under Ollama, or any OpenAI-compatible endpoint you have a key
          for. LightAudit ships no AI credentials, so nothing is billed to us and
          nothing leaves your machine unless the provider you chose is remote.
        </p>

        {/* resolved provider — what an analysis would actually use right now */}
        <div
          className={cn(
            "flex flex-col gap-3 rounded-md border px-4 py-3",
            ready
              ? "border-emerald-500/30 bg-emerald-500/5"
              : "border-amber-500/30 bg-amber-500/5",
          )}
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Readout label="Provider" value={status?.label ?? "—"} />
            <Readout
              label="Model"
              value={
                status?.model ? (
                  status.model
                ) : (
                  <span className="text-muted-foreground">provider default</span>
                )
              }
            />
            <Readout
              label="Endpoint"
              value={
                status?.baseUrl ?? (
                  <span className="text-muted-foreground">n/a</span>
                )
              }
            />
            <Readout
              label="Web research"
              value={
                status?.canWebResearch ? (
                  status.researchConfigured ? (
                    <span className="text-emerald-400">grounded</span>
                  ) : (
                    <span className="text-amber-400">no server</span>
                  )
                ) : (
                  <span className="text-amber-400">data only</span>
                )
              }
            />
          </dl>

          {status?.missing ? (
            <div className="flex items-start gap-3 border-t border-amber-500/20 pt-3 text-sm text-muted-foreground">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-amber-400"
                aria-hidden="true"
              />
              <span>{status.missing}</span>
            </div>
          ) : (
            <div className="flex items-start gap-3 border-t border-emerald-500/20 pt-3 text-sm text-muted-foreground">
              <CheckCircle2
                className="mt-0.5 size-4 shrink-0 text-emerald-400"
                aria-hidden="true"
              />
              <span>
                {status?.canWebResearch
                  ? "Analyses run on Claude and can research fixes on the web when a research server is connected."
                  : "Analyses run on this provider from the audit data alone — no web research, and fixes carry no citations."}
              </span>
            </div>
          )}
        </div>

        {/* local Ollama detection */}
        <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-background/50 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <HardDrive
                className={cn(
                  "size-4 shrink-0",
                  ollama?.running ? "text-emerald-400" : "text-muted-foreground",
                )}
                aria-hidden="true"
              />
              <span className="text-sm font-medium text-foreground">
                Local Ollama
              </span>
            </div>
            <Badge
              variant="outline"
              className={cn(
                "font-mono text-[0.6rem] uppercase tracking-[0.12em]",
                ollama?.running
                  ? "border-emerald-500/40 text-emerald-400"
                  : "border-border/60 text-muted-foreground",
              )}
            >
              {loading ? "checking" : ollama?.running ? "detected" : "not running"}
            </Badge>
          </div>

          {ollama?.running ? (
            ollama.models.length > 0 ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {ollama.models.length}{" "}
                  {ollama.models.length === 1 ? "model" : "models"} installed at{" "}
                  <span className="font-mono text-foreground">{ollama.baseUrl}</span>.
                  Use one of these tags as your model id:
                </p>
                <ul className="flex flex-wrap gap-1.5">
                  {ollama.models.map((model) => (
                    <li key={model.name}>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 font-mono text-[0.7rem] text-foreground">
                        {model.name}
                        {model.parameterSize ? (
                          <span className="text-muted-foreground">
                            {model.parameterSize}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Ollama is running at{" "}
                <span className="font-mono text-foreground">{ollama.baseUrl}</span>{" "}
                but has no models installed. Pull one first, e.g.{" "}
                <span className="font-mono text-foreground">
                  ollama pull qwen2.5-coder:14b
                </span>
                .
              </p>
            )
          ) : (
            <p className="text-xs text-muted-foreground">
              Nothing answered at{" "}
              <span className="font-mono text-foreground">
                {ollama?.baseUrl ?? "http://localhost:11434"}
              </span>
              . Start it with{" "}
              <span className="font-mono text-foreground">ollama serve</span>, or
              point{" "}
              <span className="font-mono text-foreground">OLLAMA_BASE_URL</span> at
              wherever yours runs.
            </p>
          )}
        </div>

        {/* how to switch */}
        <div className="flex flex-col gap-3 border-t border-border/50 pt-4 text-xs text-muted-foreground">
          <span>
            Choose a provider in a{" "}
            <span className="font-mono text-foreground">.env</span> file in the
            project root, then restart the server.{" "}
            <span className="font-mono text-foreground">.env</span> is gitignored,
            so your keys stay out of version control.
          </span>

          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground">
              Claude — default, can cite sources
            </span>
            <EnvSnippet lines={["LH_ANALYSIS_PROVIDER=claude"]} />
            <span>
              Uses your existing Claude Code / Max login on this machine, or{" "}
              <span className="font-mono text-foreground">ANTHROPIC_API_KEY</span>{" "}
              if you set one.
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground">
              Ollama — local &amp; private, no web research
            </span>
            <EnvSnippet
              lines={[
                "LH_ANALYSIS_PROVIDER=ollama",
                `LH_ANALYSIS_MODEL=${suggestedModel}`,
                "# OLLAMA_BASE_URL=http://localhost:11434",
              ]}
            />
            <span className="flex items-start gap-1.5">
              <GlobeLock
                className="mt-0.5 size-3 shrink-0 text-amber-400"
                aria-hidden="true"
              />
              <span>
                Local models don&apos;t browse, so these analyses are diagnosed
                from the audit data alone and are badged{" "}
                <span className="font-mono text-foreground">no web research</span>.
                Pick a model with a large context window — 14B and up reason about
                a full audit noticeably better than 7B.
              </span>
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground">
              Any OpenAI-compatible endpoint
            </span>
            <EnvSnippet
              lines={[
                "LH_ANALYSIS_PROVIDER=openai-compatible",
                "LH_ANALYSIS_BASE_URL=https://api.example.com/v1",
                "LH_ANALYSIS_MODEL=your-model-id",
                "LH_ANALYSIS_API_KEY=your-key-here",
              ]}
            />
            <span>
              Covers OpenAI, OpenRouter, LM Studio, vLLM and anything else that
              speaks the same chat-completions API. The key is read from the
              environment only — it is never stored by the app.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Live "armed / needs setup" indicator driven by the server status endpoint. */
function StatusPill({
  loading,
  status,
}: {
  loading: boolean;
  status: AiProviderStatus | null;
}) {
  if (loading) {
    return (
      <Badge variant="outline" className="gap-1.5 font-mono text-[0.65rem]">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        CHECKING
      </Badge>
    );
  }
  if (status === null) {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 border-border/60 font-mono text-[0.65rem] text-muted-foreground"
      >
        UNKNOWN
      </Badge>
    );
  }
  return status.missing === null ? (
    <Badge
      variant="outline"
      className="gap-1.5 border-emerald-500/40 font-mono text-[0.65rem] text-emerald-400"
    >
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
      </span>
      {status.label.toUpperCase()}
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="gap-1.5 border-amber-500/40 font-mono text-[0.65rem] text-amber-400"
    >
      NEEDS SETUP
    </Badge>
  );
}
