"use client";

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { CheckCircle2, Loader2, Radar } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Research MCP server status.
 *
 * AI score analysis diagnoses from the Lighthouse data on its own, and can
 * additionally research current fixes on the web so each recommendation cites a
 * real source. That research runs on an MCP server.
 *
 * That server is a SEPARATE application: the user installs it, authenticates it,
 * and declares it in a standard MCP config. LightAudit does not bundle, install,
 * or manage it, and never handles its credentials — so this panel is read-only
 * status plus guidance, with no key entry and nothing stored.
 */
export function ResearchServerSettings() {
  const [configured, setConfigured] = useState<boolean | null>(null);

  // Pure read — no setState, so it's safe to call synchronously from an effect.
  const fetchStatus = useCallback(async (): Promise<boolean | null> => {
    try {
      const res = await fetch("/api/settings/research-status", { cache: "no-store" });
      if (!res.ok) return null;
      const body = (await res.json()) as { configured?: boolean };
      return Boolean(body.configured);
    } catch {
      return null;
    }
  }, []);

  // State is applied in an effect-event, keeping setState out of reactive effect
  // scope — the codebase's mount-fetch pattern.
  const applyStatus = useEffectEvent((value: boolean | null) => setConfigured(value));
  useEffect(() => {
    let active = true;
    void fetchStatus().then((value) => {
      if (active) applyStatus(value);
    });
    return () => {
      active = false;
    };
  }, [fetchStatus]);

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
              Research MCP server
            </h2>
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
              Optional · AI analysis
            </span>
          </div>
        </div>
        <StatusPill configured={configured} />
      </header>

      <div className="flex flex-col gap-5 px-5 py-5">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          AI analysis always diagnoses from your Lighthouse data. If you connect a
          research MCP server, it will additionally look up current fixes on the
          web so each recommendation cites a real source. Everything else —
          audits, crawls, history, compare and PageSpeed — works without one.
        </p>

        <div
          className={cn(
            "flex flex-col gap-3 rounded-md border px-4 py-3",
            configured
              ? "border-emerald-500/30 bg-emerald-500/5"
              : "border-border/60 bg-background/50",
          )}
        >
          <div className="flex items-start gap-3 text-sm text-muted-foreground">
            {configured ? (
              <CheckCircle2
                className="mt-0.5 size-4 shrink-0 text-emerald-400"
                aria-hidden="true"
              />
            ) : (
              <Radar className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span>
              {configured
                ? "A research server is configured. AI fixes will cite sources it fetches."
                : "No research server configured — AI fixes will be ungrounded (diagnosis only)."}
            </span>
          </div>

          <div className="flex flex-col gap-1.5 border-t border-border/50 pt-3 text-xs text-muted-foreground">
            <span>
              Declare one under{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                mcpServers.research
              </code>{" "}
              in an MCP config file. LightAudit reads{" "}
              <span className="font-mono text-foreground">.mcp.json</span> from its
              working directory by default; set{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                LH_RESEARCH_MCP_CONFIG
              </code>{" "}
              to point somewhere else, or{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                LH_RESEARCH_MCP_SERVER
              </code>{" "}
              to choose a differently-named server.
            </span>
            <span>
              Any MCP server offering web search and page-fetch tools will do. It
              runs as its own application under your control — LightAudit never
              stores or forwards its credentials.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Live "armed / not configured" indicator driven by the server status endpoint. */
function StatusPill({ configured }: { configured: boolean | null }) {
  if (configured === null) {
    return (
      <Badge variant="outline" className="gap-1.5 font-mono text-[0.65rem]">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        CHECKING
      </Badge>
    );
  }
  return configured ? (
    <Badge
      variant="outline"
      className="gap-1.5 border-emerald-500/40 font-mono text-[0.65rem] text-emerald-400"
    >
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
      </span>
      READY
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="gap-1.5 border-border/60 font-mono text-[0.65rem] text-muted-foreground"
    >
      NOT CONFIGURED
    </Badge>
  );
}
