"use client";

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { BellRing, CheckCircle2, Loader2, Radar } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Regression-alert webhook status.
 *
 * A Slack/Discord webhook URL is credential-shaped — anyone holding it can post
 * into the channel — so it is read from the environment (normally a gitignored
 * `.env`) and never stored by the app, never written to SQLite, and never sent
 * to the browser. That is why this panel is read-only status plus guidance
 * rather than a form: there is nowhere for a key-entry field to put a value,
 * and echoing one back would leak it into the page.
 *
 * `GET /api/settings/alert-status` reports whether the delivery layer can see a
 * URL, as a boolean only.
 *
 * The important thing this panel has to say is that "not configured" is a
 * perfectly good configuration. Alerts are armed per schedule on the Archive
 * page and every event is recorded there whether or not a webhook exists — the
 * webhook only decides whether the same event also leaves the machine.
 */
export function AlertWebhookSettings() {
  const [configured, setConfigured] = useState<boolean | null>(null);

  // Pure read — no setState, so it's safe to call synchronously from an effect.
  const fetchStatus = useCallback(async (): Promise<boolean | null> => {
    try {
      const res = await fetch("/api/settings/alert-status", {
        cache: "no-store",
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { configured?: boolean };
      return Boolean(body.configured);
    } catch {
      return null;
    }
  }, []);

  // State is applied in an effect-event, keeping setState out of reactive effect
  // scope — the codebase's mount-fetch pattern.
  const applyStatus = useEffectEvent((value: boolean | null) =>
    setConfigured(value),
  );
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
            <BellRing className="size-4" aria-hidden="true" />
          </span>
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              Regression alert webhook
            </h2>
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
              Optional · Slack / Discord / any POST endpoint
            </span>
          </div>
        </div>
        <StatusPill configured={configured} />
      </header>

      <div className="flex flex-col gap-5 px-5 py-5">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          An armed schedule compares each fire with the one before it and records
          every score that crossed a pass bar, recovered, or slid by more than
          its minimum. Those events always appear on the{" "}
          <span className="font-mono text-foreground">Scheduled archive</span>{" "}
          page. Setting a webhook additionally posts each one to a channel, so a
          03:00 regression reaches you without opening the app.
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
              <Radar
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <span>
              {configured
                ? "A webhook is configured — alerts are posted to it as well as recorded in the archive."
                : "No webhook configured — alerts are recorded in the archive only. Nothing is lost; nothing leaves this machine."}
            </span>
          </div>

          <div className="flex flex-col gap-1.5 border-t border-border/50 pt-3 text-xs text-muted-foreground">
            <span>
              Add it to a{" "}
              <span className="font-mono text-foreground">.env</span> file in the
              project root, then restart the server:
            </span>
            <code
              translate="no"
              className="rounded bg-muted px-2 py-1.5 font-mono text-foreground"
            >
              LH_ALERT_WEBHOOK_URL=https://your-chat-host.example/webhook/id
            </code>
            <span>
              The URL is credential-shaped — anyone holding it can post to your
              channel — so LightAudit Score reads it from the environment and
              never stores, displays, or sends it to the browser. This panel only
              ever reports whether one is present.
            </span>
          </div>
        </div>

        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Alerts are armed <span className="text-foreground">per schedule</span>,
          not here: open{" "}
          <span className="font-mono text-foreground">Scheduled archive</span>,
          edit a schedule, and switch its Alerts on to choose which categories it
          watches and how big a drop has to be. Arming copies your current pass
          thresholds into that schedule, which then keeps its own copy.
        </p>
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
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
      </span>
      READY
    </Badge>
  ) : (
    // Deliberately not amber like the PSI panel's: a missing PageSpeed key
    // breaks PageSpeed audits, whereas a missing webhook breaks nothing. This
    // is a neutral statement of fact, not a warning.
    <Badge variant="outline" className="gap-1.5 font-mono text-[0.65rem]">
      IN-APP ONLY
    </Badge>
  );
}
