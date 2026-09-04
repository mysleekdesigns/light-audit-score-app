"use client";

/**
 * Edit-schedule dialog — the Scheduled archive's counterpart to
 * `SaveScheduleDialog`.
 *
 * A schedule used to be frozen the moment it was created: the API has always
 * accepted a partial update, but nothing in the app ever called it, so changing
 * a fire time meant deleting the schedule and rebuilding it from the audit form.
 * This edits the three fields that decide *when* a schedule runs — name, daily
 * time, and whether it is armed at all — and sends only what actually changed.
 *
 * What it deliberately does NOT edit is the target and the audit options. Those
 * are a whole audit form's worth of controls, they are already authored on the
 * Lighthouse and PageSpeed pages, and folding them in here would turn a
 * three-field dialog into a second copy of that form. They are shown read-only
 * instead, so the dialog still says what the schedule will do.
 *
 * The live cadence readout is the point of the thing. Moving a time *backwards*
 * past a moment that has already gone by today makes the schedule fire within a
 * minute of saving, because the scheduler asks whether the most recent
 * occurrence has been covered and the answer becomes no. Rather than describe
 * that in help text, the dialog asks the scheduler's own predicate
 * ({@link isDueAt}) and says plainly which of the two things is about to happen.
 *
 * Visual contract: the house "precision instrument" language, and specifically
 * the one `SaveScheduleDialog` already set — the same `Dialog` + `Field` +
 * `Input` primitives, the same mono telemetry caption for the read-only strip,
 * no new colours and no new fonts.
 */

import { useId, useMemo, useState } from "react";
import { CalendarClock, Loader2, TriangleAlert } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useMinuteTick } from "@/hooks/useMinuteTick";
import { isDueAt, lastDueMoment, nextFireAt } from "@/lib/schedules/cadence";
import {
  describeTarget,
  formatCountdown,
  formatTimestamp,
} from "@/lib/schedules/format";
import { isValidTime, type Schedule } from "@/lib/schedules/types";

/** Mono uppercase tracked label — house "telemetry" style. */
const SECTION_LABEL =
  "font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground";

export interface EditScheduleDialogProps {
  /** Controls the dialog's open state. */
  open: boolean;
  /**
   * The control that opens this dialog. Focus is returned to it on close.
   *
   * Radix restores focus to its own `DialogTrigger`, and this dialog has none —
   * it is driven by the `open` prop from a button that is already a tooltip
   * trigger. Without this, closing drops focus onto `<body>` and a keyboard user
   * has to tab back through the whole page to get where they were.
   */
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
  /** Called when the dialog requests close (cancel, escape, save). */
  onOpenChange: (open: boolean) => void;
  /** The schedule being edited; seeds the form every time the dialog opens. */
  schedule: Schedule;
  /** Called after a successful save so the caller can re-read the server list. */
  onSaved?: () => void;
}

/**
 * The fields this dialog is allowed to change. Narrower than
 * `UpdateScheduleInput` on purpose — see the file header.
 */
interface EditablePatch {
  name?: string;
  time?: string;
  enabled?: boolean;
}

/**
 * The dialog shell. The form lives in a child so that Radix unmounting the
 * content on close re-seeds every field from the schedule on the next open —
 * state derived from props at mount, rather than an effect that syncs them.
 */
export function EditScheduleDialog({
  open,
  restoreFocusRef,
  onOpenChange,
  schedule,
  onSaved,
}: EditScheduleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          const trigger = restoreFocusRef?.current;
          // No ref supplied: leave Radix's own restore behaviour alone.
          if (!trigger) return;
          event.preventDefault();
          trigger.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="inline-flex items-center gap-2">
            <CalendarClock aria-hidden className="size-4 text-primary" />
            Edit schedule
          </DialogTitle>
          <DialogDescription>
            Rename it, move the daily fire time, or disarm it. The target and
            audit options stay as they were saved.
          </DialogDescription>
        </DialogHeader>

        <EditScheduleForm
          schedule={schedule}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
        />
      </DialogContent>
    </Dialog>
  );
}

function EditScheduleForm({
  schedule,
  onOpenChange,
  onSaved,
}: {
  schedule: Schedule;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const nameId = useId();
  const timeId = useId();
  const enabledId = useId();

  const [name, setName] = useState(schedule.name);
  const [time, setTime] = useState(schedule.time);
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [saving, setSaving] = useState(false);

  // Same wall clock the card's "Next run" cell reads, so the preview below and
  // the cell behind the dialog can never disagree.
  const now = useMinuteTick();

  const timeValid = isValidTime(time);
  const trimmedName = name.trim();
  // Same description the card titles itself with, so the placeholder shows the
  // exact string that appears once the name is cleared.
  const target = useMemo(
    () => describeTarget(schedule.target),
    [schedule.target],
  );

  // Only what actually changed goes over the wire: PATCH takes a partial body,
  // and sending an untouched field would bump `updatedAt` for nothing.
  const patch = useMemo<EditablePatch>(() => {
    const next: EditablePatch = {};
    if (trimmedName !== schedule.name) next.name = trimmedName;
    if (time !== schedule.time) next.time = time;
    if (enabled !== schedule.enabled) next.enabled = enabled;
    return next;
  }, [trimmedName, time, enabled, schedule.name, schedule.time, schedule.enabled]);

  const dirty = Object.keys(patch).length > 0;

  // What "Next run" becomes once this is saved: the next occurrence of the
  // edited time, and whether the scheduler will consider the schedule overdue
  // the moment it lands. `missed` is the slot it would be overdue *for*, which
  // is not always today's — when the edited time is still ahead of now, the
  // cutoff rolls back to yesterday's occurrence, and naming the wrong day would
  // make the warning read as nonsense.
  const preview = useMemo(() => {
    if (!enabled || !timeValid || !now) return null;
    return {
      due: isDueAt(time, schedule.lastFiredAt, now),
      at: nextFireAt(time, now),
      missed: lastDueMoment(time, now),
    };
  }, [enabled, timeValid, now, time, schedule.lastFiredAt]);

  const canSave = timeValid && dirty && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    try {
      const response = await fetch(
        `/api/schedules/${encodeURIComponent(schedule.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      const body = (await response.json().catch(() => null)) as
        | { id?: string; error?: { message?: string } }
        | null;
      if (!response.ok) {
        throw new Error(
          body?.error?.message ?? `Request failed (${response.status}).`,
        );
      }
      toast.success(
        preview?.due
          ? "Schedule updated — it is overdue, so a run starts within a minute."
          : "Schedule updated.",
      );
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not save the schedule.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={nameId}>Name</FieldLabel>
          <Input
            id={nameId}
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={target.label}
            maxLength={120}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-sm"
          />
          {/* The placeholder already shows the fallback, so spelling it out
              again here would print the same URL twice in one field. */}
          <p className="font-mono text-[0.65rem] text-muted-foreground">
            Optional — empty falls back to the target shown below.
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
            autoComplete="off"
            aria-invalid={!timeValid}
            className="font-mono text-sm tabular-nums"
          />
          {timeValid ? null : (
            <p className="font-mono text-[0.65rem] text-score-poor">
              Time must be HH:MM (24h).
            </p>
          )}
        </Field>

        {/* Armed/disarmed. This is the only control in the app that sets
            `enabled`; the card's Pause button stops a batch that is already
            running, which is a different thing entirely. */}
        <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 bg-card/30 p-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Label htmlFor={enabledId} className="text-sm font-medium">
              Armed
            </Label>
            <p className="font-mono text-[0.65rem] text-muted-foreground">
              {enabled
                ? "Fires every day at the time above."
                : "Disarmed — it never fires until you switch this back on."}
            </p>
          </div>
          {/* Named by the visible <Label htmlFor> above. An aria-label here
              would override that text, leaving the accessible name and the
              on-screen word different. */}
          <Switch
            id={enabledId}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>

        {/* Cadence preview — the same readout as the card's "Next run" cell,
            recomputed against the edited time before anything is saved. */}
        <section
          aria-label="Cadence preview"
          aria-live="polite"
          className="flex flex-col gap-2 rounded-md border border-border/60 bg-card/30 p-3"
        >
          <span className={SECTION_LABEL}>Next run after saving</span>
          {!enabled ? (
            <p className="font-mono text-xs text-muted-foreground">
              Never — the schedule is disarmed.
            </p>
          ) : !timeValid ? (
            <p className="font-mono text-xs text-muted-foreground">
              Set a valid time to see when it fires.
            </p>
          ) : !preview || !now ? (
            <p className="font-mono text-xs text-muted-foreground">…</p>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="font-mono text-xs tabular-nums text-foreground">
                {formatTimestamp(preview.at.toISOString())}
                <span className="ml-2 text-muted-foreground">
                  {formatCountdown(preview.at, now)}
                </span>
              </p>
              {preview.due ? (
                <p className="flex items-start gap-1.5 font-mono text-[0.65rem] leading-relaxed text-score-average">
                  <TriangleAlert
                    aria-hidden
                    className="mt-px size-3 shrink-0"
                  />
                  <span>
                    Once saved it is overdue. The{" "}
                    {formatTimestamp(preview.missed.toISOString())} slot passed
                    without firing, so a run starts within a minute. The time
                    above is the one after that.
                  </span>
                </p>
              ) : null}
            </div>
          )}
        </section>

        {/* What this dialog does not edit — shown so the schedule still
            describes itself, and so nobody goes looking for the controls. */}
        <section
          aria-label="Unchanged by this dialog"
          className="flex flex-col gap-2 rounded-md border border-dashed border-border/60 p-3"
        >
          <span className={SECTION_LABEL}>Target &amp; options (unchanged)</span>
          <p className="truncate font-mono text-xs text-foreground">
            {target.label}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground tabular-nums">
            {target.detail ? (
              <span className="text-foreground">{target.detail}</span>
            ) : null}
            {schedule.source === "psi" ? (
              <span>
                Engine <span className="text-primary">PageSpeed</span>
              </span>
            ) : null}
            <span>
              Device <span className="text-foreground">{schedule.device}</span>
            </span>
            <span>
              Runs <span className="text-foreground">{schedule.options.runs}</span>
            </span>
            <span>
              Conc. <span className="text-foreground">{schedule.concurrency}</span>
            </span>
            {schedule.accuracyMode ? (
              <span className="text-score-good">accuracy on</span>
            ) : null}
          </div>
        </section>
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={saving}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="button" onClick={handleSave} disabled={!canSave}>
          {saving ? (
            <>
              <Loader2 data-icon="inline-start" className="animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <CalendarClock data-icon="inline-start" />
              Save changes
            </>
          )}
        </Button>
      </DialogFooter>
    </>
  );
}
