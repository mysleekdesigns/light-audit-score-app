"use client";

/**
 * Save-as-daily dialog (PRD §6 Phase 14).
 *
 * Captures `name` (free text) + `time` (HH:MM 24h) and previews the target
 * derived from the New-Audit form state. Submits to `POST /api/schedules`,
 * which validates via `parseCreateScheduleBody` and persists. On success the
 * caller navigates to `/schedule` (where the new entry lives) — we let the
 * caller decide so this dialog stays self-contained.
 *
 * Visual contract: reuses the existing `Dialog` primitive + the form's
 * `Field`/`Input` + `Button`; no new colours, no new fonts. The preview block
 * uses the same "telemetry strip" mono cap from the rest of the app.
 */

import { useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type {
  AuditOptions,
  AuditSource,
  DeviceSelection,
} from "@/lib/lighthouse/types";
import { isValidTime, type ScheduleTarget } from "@/lib/schedules/types";
import { cn } from "@/lib/utils";

/** Mono uppercase tracked label — house "telemetry" style. */
const SECTION_LABEL =
  "font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground";

export interface SaveScheduleDialogProps {
  /** Controls the dialog's open state. */
  open: boolean;
  /** Called when the dialog requests close (cancel, escape, success). */
  onOpenChange: (open: boolean) => void;
  /** Target derived from the New-Audit form's current state. */
  target: ScheduleTarget;
  /** Resolved options the schedule should fire with. */
  options: AuditOptions;
  /** Resolved concurrency the schedule should fire with. */
  concurrency: number;
  /** Device selection (`"both"` fans each URL into mobile + desktop). */
  device: DeviceSelection;
  /** Accuracy-mode flag the schedule should fire with. */
  accuracyMode: boolean;
  /** Engine each fired batch runs on (PSI feature). Defaults to the local engine. */
  source?: AuditSource;
  /** Optional callback fired with the created schedule's id on success. */
  onCreated?: (scheduleId: string) => void;
}

const DEFAULT_TIME = "09:00";

export function SaveScheduleDialog({
  open,
  onOpenChange,
  target,
  options,
  concurrency,
  device,
  accuracyMode,
  source = "local",
  onCreated,
}: SaveScheduleDialogProps) {
  const nameId = useId();
  const timeId = useId();

  const router = useRouter();
  const [name, setName] = useState("");
  const [time, setTime] = useState(DEFAULT_TIME);
  const [submitting, setSubmitting] = useState(false);

  // A short, sensible default name when the user leaves it blank — the URL
  // (sans scheme) of the first target. The server's schema accepts empty.
  const defaultName = useMemo(() => deriveDefaultName(target), [target]);

  const trimmedName = name.trim();
  const timeValid = isValidTime(time);
  const targetReady = isTargetReady(target);
  const canSubmit = timeValid && targetReady && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName || defaultName,
          enabled: true,
          cadence: "daily",
          time,
          target,
          options,
          concurrency,
          device,
          accuracyMode,
          source,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { id?: string; error?: { message?: string } }
        | null;
      if (!response.ok || !body?.id) {
        throw new Error(
          body?.error?.message ?? `Request failed (${response.status}).`,
        );
      }
      toast.success("Daily schedule saved.", {
        action: {
          label: "View",
          onClick: () => router.push("/schedule"),
        },
      });
      onCreated?.(body.id);
      // Reset for next time and close.
      setName("");
      setTime(DEFAULT_TIME);
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not save the schedule.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="inline-flex items-center gap-2">
            <CalendarPlus aria-hidden className="size-4 text-primary" />
            Save as daily schedule
          </DialogTitle>
          <DialogDescription>
            Fires once per day at the chosen HH:MM, re-resolves the target, and
            persists the batch in the Archive.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={nameId}>Name</FieldLabel>
            <Input
              id={nameId}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={defaultName}
              maxLength={120}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-sm"
            />
            <p className="font-mono text-[0.65rem] text-muted-foreground">
              Optional — defaults to{" "}
              <span className="text-foreground">{defaultName}</span>.
            </p>
          </Field>

          <Field>
            <FieldLabel htmlFor={timeId}>Fires at (server-local)</FieldLabel>
            <Input
              id={timeId}
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              required
              aria-invalid={!timeValid}
              className="font-mono text-sm tabular-nums"
            />
            {!timeValid ? (
              <p className="font-mono text-[0.65rem] text-score-poor">
                Time must be HH:MM (24h).
              </p>
            ) : null}
          </Field>

          {/* Target preview — same dense mono treatment as the telemetry strips. */}
          <section
            aria-label="Target preview"
            className={cn(
              "flex flex-col gap-2 rounded-md border border-border/60 bg-card/30 p-3",
            )}
          >
            <span className={SECTION_LABEL}>Target</span>
            <TargetPreview target={target} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground tabular-nums">
              {source === "psi" ? (
                <span>
                  Engine <span className="text-primary">PageSpeed</span>
                </span>
              ) : null}
              <span>
                Device <span className="text-foreground">{device}</span>
              </span>
              <span>
                Runs <span className="text-foreground">{options.runs}</span>
              </span>
              <span>
                Conc.{" "}
                <span className="text-foreground">{concurrency}</span>
              </span>
              <span>
                Throttling{" "}
                <span className="text-foreground">{options.throttling}</span>
              </span>
              {accuracyMode ? (
                <span className="text-score-good">accuracy on</span>
              ) : null}
            </div>
          </section>

          {!targetReady ? (
            <p className="font-mono text-[0.65rem] text-score-average">
              Add at least one URL (or a crawl spec) before saving.
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={submitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting ? (
              <>
                <Loader2 data-icon="inline-start" className="animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <CalendarPlus data-icon="inline-start" />
                Save schedule
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Strip scheme from the first URL of a target for the default name. */
function deriveDefaultName(target: ScheduleTarget): string {
  const raw = target.kind === "urls" ? target.urls[0] : target.spec.url;
  if (!raw) return "Daily audit";
  return raw.replace(/^https?:\/\//, "");
}

/** A schedule target is ready when it has at least one URL (or a crawl url). */
function isTargetReady(target: ScheduleTarget): boolean {
  if (target.kind === "urls") return target.urls.length > 0;
  return target.spec.url.trim().length > 0;
}

interface TargetPreviewProps {
  target: ScheduleTarget;
}

function TargetPreview({ target }: TargetPreviewProps) {
  if (target.kind === "crawl") {
    return (
      <div className="flex flex-col gap-1">
        <p className="truncate font-mono text-xs text-foreground">
          {target.spec.url.replace(/^https?:\/\//, "")}
        </p>
        <p className="font-mono text-[0.65rem] text-muted-foreground">
          crawl · depth {target.spec.maxDepth} · ≤{target.spec.maxPages} pages
          {target.spec.useSitemap ? " · sitemap" : ""}
          {target.spec.excludePaths.length > 0
            ? ` · ${target.spec.excludePaths.length} excluded`
            : ""}
        </p>
      </div>
    );
  }
  const first = target.urls[0] ?? "";
  const more = target.urls.length - 1;
  return (
    <div className="flex flex-col gap-1">
      <p className="truncate font-mono text-xs text-foreground">
        {first.replace(/^https?:\/\//, "")}
      </p>
      <p className="font-mono text-[0.65rem] text-muted-foreground">
        {target.urls.length} URL{target.urls.length === 1 ? "" : "s"}
        {more > 0 ? ` · +${more} more` : ""}
      </p>
    </div>
  );
}
