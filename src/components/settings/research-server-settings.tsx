"use client";

/**
 * Web research settings — the research MCP server behind AI analysis.
 *
 * AI score analysis diagnoses from the Lighthouse data on its own, and can
 * additionally research current fixes on the web so each recommendation cites a
 * real source. That research runs on an MCP server, and this panel offers two:
 *
 *   - **CrawlForge** — the one named option, behind a single switch. Off by
 *     default; when on (and a key is in reach) the analysis agent launches it
 *     through `npx` on demand. The switch is the ONLY thing this panel writes.
 *   - **A custom server** — anything declared in a standard MCP config.
 *
 * Either way the server is a separate application: the user installs and
 * authenticates it, it runs under their control, and LightAudit never stores,
 * forwards, or displays its credentials. The only credential-shaped thing here
 * is a boolean — "CrawlForge's setup file exists" — never a value.
 */

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import {
  CheckCircle2,
  CircleDashed,
  FileJson2,
  Globe,
  Loader2,
  Radar,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  CRAWLFORGE_CONFIG_FILE_DISPLAY,
  CRAWLFORGE_SETUP_COMMAND,
  CRAWLFORGE_SIGNUP_URL,
  CRAWLFORGE_VERSION_ENV,
  type CrawlforgeStatus,
  type ResearchStatus,
  crawlforgePackageSpec,
} from "@/lib/analysis/researchStatus";
import { getResearchStatus, setCrawlforgeEnabled } from "@/lib/client/research";
import { cn } from "@/lib/utils";

/** Inline code, matching the other settings panels. Never auto-translated. */
function Code({ children }: { children: React.ReactNode }) {
  return (
    <code translate="no" className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
      {children}
    </code>
  );
}

/**
 * The status as it will read once the switch lands — the optimistic frame shown
 * while the server confirms. Only what the switch alone can change is derived;
 * the server's answer replaces the whole thing.
 */
function withSwitch(status: ResearchStatus, enabled: boolean): ResearchStatus {
  const active = enabled && status.crawlforge.available;
  return {
    ...status,
    crawlforge: { ...status.crawlforge, enabled, active },
    source: active ? "crawlforge" : status.configDeclared ? "config" : null,
    configured: active || status.configDeclared,
  };
}

export function ResearchServerSettings() {
  const [status, setStatus] = useState<ResearchStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Pure read — no setState, so it's safe to call synchronously from an effect.
  const fetchStatus = useCallback(() => getResearchStatus(), []);

  // State is applied in an effect-event, keeping setState out of reactive effect
  // scope — the codebase's mount-fetch pattern.
  const applyStatus = useEffectEvent((value: ResearchStatus | null) => {
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

  const onToggle = (enabled: boolean) => {
    if (!status) return;
    const before = status;
    setSaving(true);
    // Flip immediately; the server's answer settles it, and a failure reverts.
    setStatus(withSwitch(before, enabled));
    setCrawlforgeEnabled(enabled)
      .then((next) => setStatus(next))
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Could not save the setting.");
        setStatus(before);
      })
      .finally(() => setSaving(false));
  };

  return (
    <section className="rounded-lg border border-border/60 bg-card/40">
      {/* instrument header strip */}
      <header className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-md border border-border/70 bg-background/60 text-primary">
            <Radar className="size-4" aria-hidden="true" />
          </span>
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              Web research
            </h2>
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
              Optional · AI analysis
            </span>
          </div>
        </div>
        <StatusPill loading={loading} status={status} />
      </header>

      <div className="flex flex-col gap-5 px-5 py-5">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          AI analysis always diagnoses from your Lighthouse data. Connect a
          research server and it will additionally look up current fixes on the
          web, so each recommendation cites a page the model actually read.
          Everything else — audits, crawls, history, compare and PageSpeed —
          works without one.
        </p>

        <CrawlforgeCard
          crawlforge={status?.crawlforge ?? null}
          disabled={loading || saving || status === null}
          saving={saving}
          onToggle={onToggle}
        />

        <CustomServerNote status={status} />
      </div>
    </section>
  );
}

/** Live indicator for the section as a whole, driven by the status endpoint. */
function StatusPill({ loading, status }: { loading: boolean; status: ResearchStatus | null }) {
  if (loading) {
    return (
      <Badge variant="outline" className="gap-1.5 font-mono text-[0.65rem]">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        CHECKING
      </Badge>
    );
  }
  if (status?.configured) {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 border-emerald-500/40 font-mono text-[0.65rem] text-emerald-400"
      >
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
        </span>
        READY · {status.source === "crawlforge" ? "CRAWLFORGE" : "CUSTOM"}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="gap-1.5 border-border/60 font-mono text-[0.65rem] text-muted-foreground"
    >
      {status === null ? "UNKNOWN" : "NOT CONFIGURED"}
    </Badge>
  );
}

/** The four things the switch can mean, given what is (and is not) in reach. */
type CrawlforgeState = "unknown" | "active" | "needs-key" | "ready" | "off";

function crawlforgeState(crawlforge: CrawlforgeStatus | null): CrawlforgeState {
  if (!crawlforge) return "unknown";
  if (crawlforge.active) return "active";
  if (crawlforge.enabled) return "needs-key";
  return crawlforge.available ? "ready" : "off";
}

const STATE_COPY: Record<CrawlforgeState, string> = {
  unknown: "Checking…",
  active: "Active — the next AI analysis will search and read the web through CrawlForge.",
  "needs-key":
    "Switched on, but CrawlForge has not been set up on this machine. Run the setup below and the next analysis will pick it up.",
  ready: "CrawlForge is set up. Turn it on and the next AI analysis will cite real sources.",
  off: "Off. Set up CrawlForge, turn it on, and AI fixes will cite pages the model actually read.",
};

/** The one named research server, behind one switch. */
function CrawlforgeCard({
  crawlforge,
  disabled,
  saving,
  onToggle,
}: {
  crawlforge: CrawlforgeStatus | null;
  disabled: boolean;
  saving: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const state = crawlforgeState(crawlforge);
  const StateIcon =
    state === "active" ? CheckCircle2 : state === "needs-key" ? TriangleAlert : CircleDashed;

  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-md border px-4 py-4",
        state === "active" && "border-emerald-500/30 bg-emerald-500/5",
        state === "needs-key" && "border-amber-500/30 bg-amber-500/5",
        (state === "ready" || state === "off" || state === "unknown") &&
          "border-border/60 bg-background/50",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border/70 bg-background/60 text-primary">
            <Globe className="size-4" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-1">
            <Label
              htmlFor="crawlforge-enabled"
              translate="no"
              className="text-sm font-semibold tracking-tight text-foreground"
            >
              CrawlForge
            </Label>
            <span className="text-xs leading-relaxed text-muted-foreground">
              Web search and page reading for AI analysis, metered on your own
              CrawlForge account. One switch — no MCP config to write.
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          {saving ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : null}
          <Switch
            id="crawlforge-enabled"
            checked={crawlforge?.enabled ?? false}
            onCheckedChange={onToggle}
            disabled={disabled}
            aria-describedby="crawlforge-state"
          />
        </div>
      </div>

      <p
        id="crawlforge-state"
        aria-live="polite"
        className={cn(
          "flex items-start gap-2 text-sm",
          state === "active"
            ? "text-emerald-400"
            : state === "needs-key"
              ? "text-amber-400"
              : "text-muted-foreground",
        )}
      >
        <StateIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{STATE_COPY[state]}</span>
      </p>

      <dl className="grid grid-cols-1 gap-3 border-t border-border/50 pt-3 sm:grid-cols-2">
        <PresenceReadout
          label="Setup file"
          value={CRAWLFORGE_CONFIG_FILE_DISPLAY}
          present={crawlforge?.setupOnDisk}
          presentLabel="FOUND"
          absentLabel="NOT FOUND"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground">
            Launches
          </dt>
          <dd className="truncate font-mono text-xs text-foreground" translate="no">
            {crawlforge ? `npx -y ${crawlforgePackageSpec(crawlforge.version)}` : "…"}
          </dd>
        </div>
      </dl>

      <ol className="flex list-decimal flex-col gap-1.5 border-t border-border/50 pt-3 pl-4 text-xs leading-relaxed text-muted-foreground">
        <li>
          Get a free API key at{" "}
          <a
            href={CRAWLFORGE_SIGNUP_URL}
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline underline-offset-2 hover:text-primary"
          >
            crawlforge.dev/signup
          </a>{" "}
          — 1,000 credits, no card.
        </li>
        <li>
          Run <Code>{CRAWLFORGE_SETUP_COMMAND}</Code> in a terminal. It validates
          the key and stores it in <Code>{CRAWLFORGE_CONFIG_FILE_DISPLAY}</Code>,
          where the server reads it itself.
        </li>
        <li>
          Turn the switch on. The first analysis fetches the pinned server
          version through <Code>npx</Code> (a few seconds); after that it starts
          from the local cache. To run a newer release, set{" "}
          <Code>{CRAWLFORGE_VERSION_ENV}=x.y.z</Code> in <Code>.env</Code>.
        </li>
      </ol>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Runs as its own process on your machine and spends credits from your
        CrawlForge account. LightAudit never reads, stores, or forwards the key
        — it only checks that the setup file exists — and keeps the analysis
        agent to CrawlForge&apos;s search and page-reading tools, so one
        analysis costs a handful of credits rather than a crawl. When on, it
        takes precedence over a custom research server.
      </p>
    </div>
  );
}

/** A mono label/value row with a present/absent badge — never the value of a secret. */
function PresenceReadout({
  label,
  value,
  present,
  presentLabel,
  absentLabel,
}: {
  label: string;
  value: string;
  present: boolean | undefined;
  presentLabel: string;
  absentLabel: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </dt>
      <dd className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-xs text-foreground">{value}</span>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 font-mono text-[0.6rem]",
            present
              ? "border-emerald-500/40 text-emerald-400"
              : "border-border/60 text-muted-foreground",
          )}
        >
          {present === undefined ? "…" : present ? presentLabel : absentLabel}
        </Badge>
      </dd>
    </div>
  );
}

/** The vendor-neutral path: a server declared in a standard MCP config. */
function CustomServerNote({ status }: { status: ResearchStatus | null }) {
  const inUse = status?.source === "config";
  const declared = status?.configDeclared === true;
  const shadowed = declared && status?.source === "crawlforge";

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-background/50 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileJson2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h3 className="truncate text-sm font-medium text-foreground">Custom research server</h3>
          <span className="shrink-0 font-mono text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground">
            Advanced
          </span>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 font-mono text-[0.6rem]",
            inUse ? "border-emerald-500/40 text-emerald-400" : "border-border/60 text-muted-foreground",
          )}
        >
          {inUse ? "IN USE" : declared ? "DECLARED" : "NONE"}
        </Badge>
      </div>
      <div className="flex flex-col gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <span>
          {inUse
            ? "A server declared in your MCP config is in use — AI fixes will cite sources it fetches."
            : shadowed
              ? "A server is declared in your MCP config, but CrawlForge is switched on and takes precedence."
              : "Any MCP server offering web search and page-fetch tools will do."}
        </span>
        <span>
          Declare one under <Code>mcpServers.research</Code> in an MCP config
          file. LightAudit reads <span className="font-mono text-foreground">.mcp.json</span>{" "}
          from its working directory by default; set <Code>LH_RESEARCH_MCP_CONFIG</Code> to
          point somewhere else, or <Code>LH_RESEARCH_MCP_SERVER</Code> to choose a
          differently-named server. It runs as its own application under your
          control — LightAudit never stores or forwards its credentials.
        </span>
      </div>
    </div>
  );
}
