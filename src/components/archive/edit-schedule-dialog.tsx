"use client";

/**
 * Edit-schedule dialog — the Scheduled archive's counterpart to
 * `SaveScheduleDialog`.
 *
 * A schedule used to be frozen the moment it was created: the API has always
 * accepted a partial update, but nothing in the app ever called it, so changing
 * a fire time meant deleting the schedule and rebuilding it from the audit form.
 * This edits the three fields that decide *when* a schedule runs — name, daily
 * time, and whether it is armed at all — plus, since ROADMAP Phase C, what it
 * notifies about, and sends only what actually changed.
 *
 * ## Arming alerts copies your Settings bars; it does not mirror them
 *
 * The per-category pass bars are a *browser* setting (`useAuditDefaults`, backed
 * by `localStorage`). A scheduler firing at 03:00 on the server has no
 * `localStorage` to read, so arming alerts here copies the bars into the
 * schedule's own `notify.thresholds` and the schedule owns them from then on.
 * That is deliberate rather than a workaround — nudging a Settings dial to
 * eyeball one batch must not silently re-arm every schedule you configured
 * months ago — so the section says so in a line of copy rather than leaving the
 * user to discover it. See the `ScheduleNotify` docblock.
 *
 * There is no webhook field here, and there must never be one. A webhook URL is
 * credential-shaped: anyone holding it can post into the channel. It is read
 * from `process.env.LH_ALERT_WEBHOOK_URL` and never reaches this form, the
 * `schedules` row, or any payload the client sees (`.claude/rules/security.md`).
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

import { useCallback, useId, useMemo, useState } from "react";
import { BellRing, CalendarClock, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { notifyEquals } from "@/components/archive/alerts-data";
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
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { useAuditDefaults } from "@/hooks/useAuditDefaults";
import { useMinuteTick } from "@/hooks/useMinuteTick";
import {
  MAX_ALERT_DELTA,
  MIN_ALERT_DELTA,
  type ScheduleNotify,
} from "@/lib/alerts/types";
import {
  LIGHTHOUSE_CATEGORIES,
  type LighthouseCategory,
} from "@/lib/lighthouse/types";
import { CATEGORY_LABELS, CATEGORY_SHORT_LABELS } from "@/lib/scores";
import { isDueAt, lastDueMoment, nextFireAt } from "@/lib/schedules/cadence";
import {
  describeTarget,
  formatCountdown,
  formatTimestamp,
} from "@/lib/schedules/format";
import { isValidTime, type Schedule } from "@/lib/schedules/types";
import { cn } from "@/lib/utils";

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
  /**
   * The whole notify config, or absent when nothing about it moved. Sent whole
   * rather than per-field: the API sanitises it as one unit, and a half-config
   * (categories without their bars) has no meaning.
   */
  notify?: ScheduleNotify;
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
        // The Alerts section made this dialog tall enough to exceed a laptop
        // viewport, and `DialogContent` is a centred fixed grid with no height
        // cap — it would clip at both ends with nothing to scroll. Cap it and
        // give the middle row the scroll; header and footer stay put.
        className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg"
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
            Rename it, move the daily fire time, disarm it, or choose what it
            alerts on. The target and audit options stay as they were saved.
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
  const notifyId = useId();
  const categoriesId = useId();
  const categoriesHintId = useId();
  const deltaId = useId();
  const deltaHintId = useId();

  const [name, setName] = useState(schedule.name);
  const [time, setTime] = useState(schedule.time);
  const [enabled, setEnabled] = useState(schedule.enabled);
  // Alerts. Seeded from the saved config at mount like every other field —
  // Radix unmounts this form on close, so re-opening re-reads the schedule.
  const [notifyEnabled, setNotifyEnabled] = useState(schedule.notify.enabled);
  const [categories, setCategories] = useState<LighthouseCategory[]>(
    schedule.notify.categories,
  );
  // Held as text so the field can be cleared mid-edit without the value
  // snapping to a clamped number under the caret.
  const [deltaText, setDeltaText] = useState(String(schedule.notify.minDelta));
  const [saving, setSaving] = useState(false);

  // The user's live Settings bars — the source arming copies from, and nothing
  // more: once a schedule is armed it owns its own bars (see the file header).
  const { defaults, loaded: defaultsLoaded } = useAuditDefaults();

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

  // Alerts validity. An empty category set is refused rather than quietly
  // meaning "all" (which is how `sanitizeCategories` would read it) — a form
  // that silently watched five categories after you cleared them would be
  // lying about what it saved.
  const deltaValue = Number(deltaText);
  const deltaValid =
    /^\d+$/.test(deltaText.trim()) &&
    deltaValue >= MIN_ALERT_DELTA &&
    deltaValue <= MAX_ALERT_DELTA;
  const categoriesValid = categories.length > 0;
  const notifyValid = !notifyEnabled || (deltaValid && categoriesValid);

  // Arming for the first time is the moment the Settings bars are copied. An
  // already-armed schedule keeps the bars it owns, and disarming leaves them
  // untouched so re-arming later doesn't silently re-copy.
  const arming = notifyEnabled && !schedule.notify.enabled;
  const thresholds = arming ? defaults.thresholds : schedule.notify.thresholds;

  // Only what actually changed goes over the wire: PATCH takes a partial body,
  // and sending an untouched field would bump `updatedAt` for nothing.
  const patch = useMemo<EditablePatch>(() => {
    const next: EditablePatch = {};
    if (trimmedName !== schedule.name) next.name = trimmedName;
    if (time !== schedule.time) next.time = time;
    if (enabled !== schedule.enabled) next.enabled = enabled;

    const notify: ScheduleNotify = {
      enabled: notifyEnabled,
      categories,
      // An invalid delta never leaves the client: save is blocked while alerts
      // are armed, and a disarmed schedule keeps the number it had.
      minDelta: deltaValid ? deltaValue : schedule.notify.minDelta,
      thresholds,
    };
    if (!notifyEquals(notify, schedule.notify)) next.notify = notify;
    return next;
  }, [
    trimmedName,
    time,
    enabled,
    notifyEnabled,
    categories,
    deltaValid,
    deltaValue,
    thresholds,
    schedule.name,
    schedule.time,
    schedule.enabled,
    schedule.notify,
  ]);

  const dirty = Object.keys(patch).length > 0;

  // Categories are stored in canonical order so `notifyEquals` can compare them
  // positionally, and so the API's own `sanitizeCategories` is a no-op.
  const handleCategories = useCallback((values: string[]) => {
    const picked = new Set(values);
    setCategories(LIGHTHOUSE_CATEGORIES.filter((c) => picked.has(c)));
  }, []);

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

  // Arming is blocked until the Settings bars have actually been read from
  // `localStorage`. The store hydrates on its first client subscription, so
  // this is a single frame in practice — but saving inside it would copy the
  // factory 90s and quietly call them the user's thresholds.
  const seedReady = !arming || defaultsLoaded;
  const canSave = timeValid && notifyValid && seedReady && dirty && !saving;

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
        arming
          ? {
              description:
                "Alerts armed — the pass bars were copied from Settings and are this schedule's from now on.",
            }
          : undefined,
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
      {/* The scrolling row of the dialog grid. `overscroll-contain` keeps a
          wheel at the end of this list from scrolling the page behind the
          modal; the negative margin keeps focus rings off the clip edge. */}
      <div className="-mx-1 flex flex-col gap-4 overflow-y-auto overscroll-contain px-1">
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

        {/* Regression alerts. There is no webhook field here by design — the
            URL is credential-shaped and lives in `.env` only; Settings shows
            whether one is configured, as a boolean. Everything below is
            preference, so it is safe to persist on the schedules row. */}
        <section
          aria-label="Regression alerts"
          className="flex flex-col gap-3 rounded-md border border-border/60 bg-card/30 p-3"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Label
                htmlFor={notifyId}
                className="inline-flex items-center gap-2 text-sm font-medium"
              >
                <BellRing aria-hidden className="size-3.5 text-primary" />
                Alerts
              </Label>
              <p className="font-mono text-[0.65rem] leading-relaxed text-muted-foreground">
                {notifyEnabled
                  ? "Each fire is compared with the one before it. Events land on this card whether or not a webhook is configured."
                  : "Off — fires are recorded but never compared, so nothing is reported."}
              </p>
            </div>
            <Switch
              id={notifyId}
              checked={notifyEnabled}
              onCheckedChange={setNotifyEnabled}
            />
          </div>

          {notifyEnabled ? (
            <div className="flex flex-col gap-4 border-t border-border/50 pt-3">
              <Field data-invalid={!categoriesValid ? true : undefined}>
                <FieldLabel htmlFor={categoriesId}>
                  Watched categories
                </FieldLabel>
                {/* The FieldLabel is a <label>, which can't name a role=group
                    div — the group needs its own accessible name. */}
                <ToggleGroup
                  id={categoriesId}
                  type="multiple"
                  variant="outline"
                  spacing={0}
                  aria-label="Watched categories"
                  aria-describedby={categoriesValid ? undefined : categoriesHintId}
                  value={categories}
                  onValueChange={handleCategories}
                  className="w-full"
                >
                  {LIGHTHOUSE_CATEGORIES.map((category) => (
                    <ToggleGroupItem
                      key={category}
                      value={category}
                      title={CATEGORY_LABELS[category]}
                      className="min-w-0 flex-1 px-1 font-mono text-[0.7rem] uppercase tracking-[0.08em]"
                    >
                      {CATEGORY_SHORT_LABELS[category]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                {categoriesValid ? null : (
                  <p
                    id={categoriesHintId}
                    className="font-mono text-[0.65rem] text-score-poor"
                  >
                    Pick at least one category — an empty set watches nothing.
                  </p>
                )}
              </Field>

              <Field data-invalid={!deltaValid ? true : undefined}>
                <FieldLabel htmlFor={deltaId}>Minimum drop (points)</FieldLabel>
                <Input
                  id={deltaId}
                  type="number"
                  inputMode="numeric"
                  min={MIN_ALERT_DELTA}
                  max={MAX_ALERT_DELTA}
                  step={1}
                  value={deltaText}
                  onChange={(event) => setDeltaText(event.target.value)}
                  autoComplete="off"
                  aria-invalid={!deltaValid}
                  aria-describedby={deltaHintId}
                  className="font-mono text-sm tabular-nums"
                />
                <p
                  id={deltaHintId}
                  className={cn(
                    "font-mono text-[0.65rem] leading-relaxed",
                    deltaValid ? "text-muted-foreground" : "text-score-poor",
                  )}
                >
                  {deltaValid
                    ? `A fall of ${deltaValue} or more is reported even when it crosses no bar. Lighthouse drifts a couple of points between identical runs, so lower is noisier.`
                    : `Must be ${MIN_ALERT_DELTA}–${MAX_ALERT_DELTA}.`}
                </p>
              </Field>

              {/* The bars themselves, shown so "copied from Settings" is a
                  claim the user can check rather than take on trust. */}
              <div className="flex flex-col gap-1.5">
                <span className={SECTION_LABEL}>
                  Pass bars {arming ? "(copying now)" : "(this schedule's)"}
                </span>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground tabular-nums">
                  {LIGHTHOUSE_CATEGORIES.map((category) => (
                    <span key={category}>
                      {CATEGORY_SHORT_LABELS[category]}{" "}
                      <span className="text-foreground">
                        {thresholds[category]}
                      </span>
                    </span>
                  ))}
                </div>
                <p className="font-mono text-[0.65rem] leading-relaxed text-muted-foreground">
                  {arming
                    ? "Copied from your Settings thresholds when you save. The schedule keeps its own copy from then on — moving a Settings dial later won't change it."
                    : "Copied from Settings when alerts were first armed. This schedule owns them now; Settings no longer affects it."}
                  {arming && !defaultsLoaded
                    ? " Reading your saved thresholds…"
                    : null}
                </p>
              </div>
            </div>
          ) : null}
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
