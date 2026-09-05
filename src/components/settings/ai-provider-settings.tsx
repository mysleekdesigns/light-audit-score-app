"use client";

/**
 * AI analysis provider — status, the switch between providers, and local
 * Ollama detection.
 *
 * AI analysis runs on YOUR AI — a Claude Code / Max login, a provider key you
 * own, or a model running locally under Ollama. LightAudit Score ships no AI
 * credential of its own, so like the PageSpeed panel this is read-only status
 * plus guidance for everything credential-shaped: keys and endpoints live in
 * the environment (a gitignored `.env`) and are never accepted, stored, or
 * echoed here.
 *
 * The switch is the exception. `GET /api/settings/ai-provider` resolves exactly
 * what the analysis engine resolves — so "Ready" here means an analysis really
 * will run — probes a local Ollama for the models the user has already pulled,
 * and reports how `.env` has set up the other two options. Choosing one
 * (Claude, an installed Ollama model, or the custom endpoint with a model id)
 * saves that provider + model (`PUT`), which takes effect on the next analysis
 * with no `.env` edit or restart and overrides `.env` until "Use .env instead"
 * clears it (`DELETE`). A provider id and a model id are all that is ever
 * written; the custom endpoint's URL and key can only come from `.env`.
 */

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import {
  Check,
  CheckCircle2,
  Cpu,
  GlobeLock,
  HardDrive,
  Loader2,
  RotateCcw,
  Server,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type AiProviderChoice,
  clearAiProviderChoice,
  getAiProviderStatus,
  saveAiProviderChoice,
} from "@/lib/client/aiProvider";
import type {
  AiProviderStatus,
  CustomEndpointOption,
  OllamaModel,
  OllamaStatus,
} from "@/lib/analysis/providerStatus";
import type { ProviderSource } from "@/lib/analysis/providers/types";
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

/** An identifier in running text — a model tag, an env var, a file name. */
function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span translate="no" className="font-mono text-foreground">
      {children}
    </span>
  );
}

/** A section kicker in the panel's instrument voice. */
function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground">
      {children}
    </span>
  );
}

/** How the resolved selection was made, as the readout's suffix. */
const SOURCE_COPY: Record<ProviderSource, string> = {
  settings: "chosen in Settings",
  env: "from .env",
  default: "default",
  override: "this analysis only",
};

/** The same, short enough for a badge. */
const SOURCE_SHORT: Record<ProviderSource, string> = {
  settings: "Settings",
  env: ".env",
  default: "default",
  override: "this run",
};

/** The `.env` lines that would select this provider, ready to copy. */
function EnvSnippet({ lines }: { lines: string[] }) {
  return (
    <code className="block overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre text-foreground">
      {lines.join("\n")}
    </code>
  );
}

/** A write that didn't stick must say so; what was on screen stays as it was. */
function reportSaveError(err: unknown) {
  toast.error(err instanceof Error ? err.message : "Could not save the setting.");
}

/** The card frame every provider option sits in; emerald when it is the one running. */
function cardClass(active: boolean): string {
  return cn(
    "flex flex-col gap-3 rounded-md border px-4 py-3 transition-colors",
    active ? "border-emerald-500/30 bg-emerald-500/5" : "border-border/60 bg-background/50",
  );
}

/** Marks the option an analysis would run on right now, and what chose it. */
function ActiveBadge({ source }: { source: ProviderSource }) {
  return (
    <Badge
      variant="outline"
      className="gap-1.5 border-emerald-500/40 font-mono text-[0.6rem] uppercase tracking-[0.12em] text-emerald-400"
    >
      <Check className="size-3" aria-hidden="true" />
      Active · {SOURCE_SHORT[source]}
    </Badge>
  );
}

/** A present/absent badge for something that must never be shown — a key. */
function PresenceBadge({ present, label }: { present: boolean; label: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 font-mono text-[0.6rem]",
        present ? "border-emerald-500/40 text-emerald-400" : "border-border/60 text-muted-foreground",
      )}
    >
      {present ? `${label} SET` : `${label} NOT SET`}
    </Badge>
  );
}

export function AiProviderSettings() {
  const [status, setStatus] = useState<AiProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  /** The write in flight, if any: `claude`, `ollama:<tag>`, `custom`, or `clear`. */
  const [pending, setPending] = useState<string | null>(null);

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
  const busy = pending !== null;
  const disabled = busy || loading || status === null;
  const chosenHere = status?.source === "settings";
  const source = status?.source ?? "default";

  const choose = (choice: AiProviderChoice, key: string) => {
    if (busy) return;
    setPending(key);
    saveAiProviderChoice(choice)
      .then(setStatus)
      .catch(reportSaveError)
      .finally(() => setPending(null));
  };

  const onClear = () => {
    if (busy) return;
    setPending("clear");
    clearAiProviderChoice()
      .then(setStatus)
      .catch(reportSaveError)
      .finally(() => setPending(null));
  };

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
          for. LightAudit Score ships no AI credentials, so nothing is billed to us and
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
            <Readout
              label="Provider"
              value={
                status ? (
                  <>
                    {status.label}{" "}
                    <span className="text-muted-foreground">
                      · {SOURCE_COPY[status.source]}
                    </span>
                  </>
                ) : (
                  "—"
                )
              }
            />
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

        {/* the switch — three options, one saved choice */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <Kicker>Switch provider — saved by the app, no restart</Kicker>
            {chosenHere ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onClear}
                disabled={disabled}
                className="font-mono text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground"
              >
                {pending === "clear" ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <RotateCcw aria-hidden="true" />
                )}
                Use .env instead
              </Button>
            ) : null}
          </div>
          <p aria-live="polite" className="text-xs text-muted-foreground">
            <ChoiceCopy status={status} />
          </p>

          <ClaudeCard
            active={status?.provider === "claude"}
            source={source}
            model={status?.claude.model ?? ""}
            pending={pending === "claude"}
            disabled={disabled}
            onChoose={() => choose({ provider: "claude" }, "claude")}
          />

          <OllamaCard
            ollama={ollama ?? null}
            loading={loading}
            active={status?.provider === "ollama"}
            source={source}
            activeModel={status?.provider === "ollama" ? status.model : null}
            pending={pending}
            disabled={disabled}
            onChoose={(model) => choose({ provider: "ollama", model }, `ollama:${model}`)}
          />

          <CustomEndpointCard
            // Remount once the status is in, so the model field starts from
            // what .env (or the saved choice) already names.
            key={loading ? "loading" : "ready"}
            custom={status?.custom ?? null}
            active={status?.provider === "openai-compatible"}
            source={source}
            initialModel={
              status?.provider === "openai-compatible" ? status.model : (status?.custom.model ?? "")
            }
            pending={pending === "custom"}
            disabled={disabled}
            onChoose={(model) => choose({ provider: "openai-compatible", model }, "custom")}
          />
        </div>

        {/* the .env way */}
        <div className="flex flex-col gap-3 border-t border-border/50 pt-4 text-xs text-muted-foreground">
          <span>
            Or set it in <Mono>.env</Mono>: choose a provider in a <Mono>.env</Mono>{" "}
            file in the project root, then restart the server. <Mono>.env</Mono> is
            gitignored, so your keys stay out of version control — and it is the
            only place an endpoint or a key can be set. A choice made above
            overrides the <Mono>.env</Mono> selection until you clear it.
          </span>

          <div className="flex flex-col gap-1.5">
            <Kicker>Claude — default, can cite sources</Kicker>
            <EnvSnippet lines={["LH_ANALYSIS_PROVIDER=claude"]} />
            <span>
              Uses your existing Claude Code / Max login on this machine, or{" "}
              <Mono>ANTHROPIC_API_KEY</Mono> if you set one.
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Kicker>Ollama — local &amp; private, no web research</Kicker>
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
                <Mono>no web research</Mono>. Pick a model with a large context
                window — 14B and up reason about a full audit noticeably better
                than 7B.
              </span>
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Kicker>Any OpenAI-compatible endpoint</Kicker>
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

/** What the current selection means for the next analysis, in one line. */
function ChoiceCopy({ status }: { status: AiProviderStatus | null }) {
  if (!status) return <>Checking which provider is configured…</>;
  const what = status.model ? (
    <>
      {status.label} <Mono>{status.model}</Mono>
    </>
  ) : (
    <>{status.label}</>
  );
  if (status.source === "settings") {
    return (
      <>
        {what} runs the next analysis — chosen here, overriding <Mono>.env</Mono>{" "}
        until you clear it.
      </>
    );
  }
  if (status.source === "env") {
    return (
      <>
        {what} is selected by <Mono>.env</Mono>. Pick another option to switch
        without a restart.
      </>
    );
  }
  return <>{what} is the default. Pick another option to switch without a restart.</>;
}

/** Claude: the premium path, one click. */
function ClaudeCard({
  active,
  source,
  model,
  pending,
  disabled,
  onChoose,
}: {
  active: boolean;
  source: ProviderSource;
  model: string;
  pending: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <div className={cardClass(active)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border/70 bg-background/60 text-primary">
            <Sparkles className="size-4" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold tracking-tight text-foreground">Claude</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              Your Claude Code / Max login on this machine, or{" "}
              <Mono>ANTHROPIC_API_KEY</Mono> if you set one. The only provider that
              can research fixes on the web and cite sources.
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center pt-1">
          {active ? (
            <ActiveBadge source={source} />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onChoose}
              disabled={disabled}
              className="font-mono text-xs"
            >
              {pending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles aria-hidden="true" />
              )}
              Use Claude
            </Button>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 border-t border-border/50 pt-3">
        <Readout
          label="Model"
          value={
            model ? (
              <>
                {model} <span className="text-muted-foreground">· pinned in .env</span>
              </>
            ) : (
              <span className="text-muted-foreground">SDK default</span>
            )
          }
        />
        <Readout label="Web research" value={<span className="text-emerald-400">capable</span>} />
      </dl>
    </div>
  );
}

/** Local Ollama: detection plus one button per installed model. */
function OllamaCard({
  ollama,
  loading,
  active,
  source,
  activeModel,
  pending,
  disabled,
  onChoose,
}: {
  ollama: OllamaStatus | null;
  loading: boolean;
  active: boolean;
  source: ProviderSource;
  activeModel: string | null;
  pending: string | null;
  disabled: boolean;
  onChoose: (model: string) => void;
}) {
  return (
    <div className={cardClass(active)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <HardDrive
            className={cn(
              "size-4 shrink-0",
              ollama?.running ? "text-emerald-400" : "text-muted-foreground",
            )}
            aria-hidden="true"
          />
          <span className="text-sm font-medium text-foreground">Local Ollama</span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {active ? <ActiveBadge source={source} /> : null}
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
      </div>

      {ollama?.running ? (
        ollama.models.length > 0 ? (
          <>
            <p className="text-xs text-muted-foreground">
              Click a model to switch analyses to it.{" "}
              {ollama.models.length}{" "}
              {ollama.models.length === 1 ? "model" : "models"} installed at{" "}
              <Mono>{ollama.baseUrl}</Mono> — local and private, but no web
              research.
            </p>
            <ul className="flex flex-wrap gap-1.5" aria-label="Installed Ollama models">
              {ollama.models.map((model) => (
                <li key={model.name}>
                  <ModelButton
                    model={model}
                    active={activeModel === model.name}
                    pending={pending === `ollama:${model.name}`}
                    disabled={disabled}
                    onSelect={onChoose}
                  />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Ollama is running at <Mono>{ollama.baseUrl}</Mono> but has no models
            installed. Pull one first, e.g. <Mono>ollama pull qwen2.5-coder:14b</Mono>.
          </p>
        )
      ) : (
        <p className="text-xs text-muted-foreground">
          Nothing answered at <Mono>{ollama?.baseUrl ?? "http://localhost:11434"}</Mono>.
          Start it with <Mono>ollama serve</Mono>, or point <Mono>OLLAMA_BASE_URL</Mono>{" "}
          at wherever yours runs.
        </p>
      )}
    </div>
  );
}

/** One installed model, as the button that makes it the analysis model. */
function ModelButton({
  model,
  active,
  pending,
  disabled,
  onSelect,
}: {
  model: OllamaModel;
  active: boolean;
  pending: boolean;
  disabled: boolean;
  onSelect: (name: string) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={() => onSelect(model.name)}
      title={active ? `${model.name} runs the next analysis` : `Run analyses on ${model.name}`}
      translate="no"
      className={cn(
        // `group/model` so the empty marker below can react to hovering the chip.
        "group/model inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-left font-mono text-[0.7rem] break-all transition-all outline-none touch-manipulation",
        "focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-70",
        active
          ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
          : "border-border/60 bg-muted/40 text-foreground hover:-translate-y-px hover:border-primary/70 hover:bg-primary/10 hover:text-primary motion-reduce:hover:translate-y-0",
      )}
    >
      {pending ? (
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      ) : active ? (
        <Check className="size-3 shrink-0" aria-hidden="true" />
      ) : (
        // An empty marker on every other chip is what makes the row read as one
        // set of options to choose between. Without it each chip is shaped
        // exactly like the static "detected" badge in the corner, and nothing
        // says the list is interactive at all.
        <span
          aria-hidden="true"
          className="size-3 shrink-0 rounded-full border border-current opacity-35 transition-opacity group-hover/model:opacity-100"
        />
      )}
      {model.name}
      {model.parameterSize ? (
        <span className={active ? "text-emerald-400/70" : "text-muted-foreground"}>
          {model.parameterSize}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The OpenAI-compatible endpoint: configured in `.env` (URL + key, shown as a
 * redacted URL and a presence badge), with the model id chosen here.
 */
function CustomEndpointCard({
  custom,
  active,
  source,
  initialModel,
  pending,
  disabled,
  onChoose,
}: {
  custom: CustomEndpointOption | null;
  active: boolean;
  source: ProviderSource;
  initialModel: string;
  pending: boolean;
  disabled: boolean;
  onChoose: (model: string) => void;
}) {
  const [model, setModel] = useState(initialModel);
  const configured = custom?.configured ?? false;
  const trimmed = model.trim();

  return (
    <form
      className={cardClass(active)}
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) onChoose(trimmed);
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border/70 bg-background/60 text-primary">
            <Server className="size-4" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold tracking-tight text-foreground">
              OpenAI-compatible endpoint
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              OpenAI, OpenRouter, LM Studio, vLLM — anything that speaks the
              chat-completions API. The endpoint and key come from{" "}
              <Mono>.env</Mono>; pick the model here. Data only, no web research.
            </span>
          </div>
        </div>
        {active ? (
          <div className="flex shrink-0 items-center pt-1">
            <ActiveBadge source={source} />
          </div>
        ) : null}
      </div>

      <dl className="grid grid-cols-1 gap-3 border-t border-border/50 pt-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground">
            Endpoint
          </dt>
          <dd className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-xs text-foreground" translate="no">
              {custom?.baseUrl ?? (configured ? "set, not displayable" : "LH_ANALYSIS_BASE_URL")}
            </span>
            {custom ? <PresenceBadge present={configured} label="URL" /> : null}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground">
            API key
          </dt>
          <dd className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-xs text-foreground" translate="no">
              LH_ANALYSIS_API_KEY
            </span>
            {custom ? <PresenceBadge present={custom.hasApiKey} label="KEY" /> : null}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label
            htmlFor="custom-endpoint-model"
            className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground"
          >
            Model id
          </Label>
          <Input
            id="custom-endpoint-model"
            name="model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="e.g. gpt-4.1-mini…"
            autoComplete="off"
            spellCheck={false}
            translate="no"
            maxLength={200}
            disabled={!configured || disabled}
            className="font-mono text-xs"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={!configured || disabled || !trimmed || (active && trimmed === initialModel)}
          className="font-mono text-xs"
        >
          {pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Server aria-hidden="true" />
          )}
          Use this endpoint
        </Button>
      </div>

      {custom && !configured ? (
        <p className="flex items-start gap-2 text-xs text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Set <Mono>LH_ANALYSIS_BASE_URL</Mono> (and <Mono>LH_ANALYSIS_API_KEY</Mono>{" "}
            if the endpoint needs one) in <Mono>.env</Mono>, then restart the server.
          </span>
        </p>
      ) : null}
    </form>
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
