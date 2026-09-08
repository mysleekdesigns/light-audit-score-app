"use client";

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * PageSpeed Insights API-key status.
 *
 * LightAudit Score runs from your own checkout (`npm start`), so credentials come from
 * the environment — normally a gitignored `.env` beside the project. There is no
 * key store inside the app and nothing is written to disk by it, which is why
 * this panel is read-only status plus guidance rather than a form.
 *
 * `GET /api/settings/psi-status` reports whether a key is currently visible to
 * the server, as a boolean only — the key itself never crosses the wire.
 */
export function PsiKeySettings() {
  const [configured, setConfigured] = useState<boolean | null>(null);

  // Pure read — no setState, so it's safe to call synchronously from an effect.
  const fetchStatus = useCallback(async (): Promise<boolean | null> => {
    try {
      const res = await fetch("/api/settings/psi-status", { cache: "no-store" });
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
            <KeyRound className="size-4" aria-hidden="true" />
          </span>
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              PageSpeed Insights API key
            </h2>
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
              Google · 25k requests / day
            </span>
          </div>
        </div>
        <StatusPill configured={configured} />
      </header>

      <div className="flex flex-col gap-5 px-5 py-5">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          PageSpeed audits call Google&apos;s hosted API — so they only work online — and
          need your own free API key (the keyless quota is effectively zero). Create one in
          the{" "}
          <a
            href="https://developers.google.com/speed/docs/insights/v5/get-started#APIKey"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            Google Cloud console
          </a>{" "}
          with the{" "}
          <span className="font-mono text-foreground">PageSpeed Insights API</span>{" "}
          enabled. Local Lighthouse audits don&apos;t need it.
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
              <KeyRound
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <span>
              {configured
                ? "A PageSpeed Insights key is configured."
                : "No PageSpeed Insights key configured — PageSpeed audits will fail."}
            </span>
          </div>

          <div className="flex flex-col gap-1.5 border-t border-border/50 pt-3 text-xs text-muted-foreground">
            <span>
              Add it to a{" "}
              <span className="font-mono text-foreground">.env</span> file in the
              project root, then restart the server:
            </span>
            <code className="rounded bg-muted px-2 py-1.5 font-mono text-foreground">
              PAGESPEED_API_KEY=your-key-here
            </code>
            <span>
              Copy <span className="font-mono text-foreground">.env.example</span>{" "}
              to get started.{" "}
              <span className="font-mono text-foreground">.env</span> is gitignored,
              so your key stays out of version control.
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
      className="gap-1.5 border-amber-500/40 font-mono text-[0.65rem] text-amber-400"
    >
      NOT CONFIGURED
    </Badge>
  );
}
