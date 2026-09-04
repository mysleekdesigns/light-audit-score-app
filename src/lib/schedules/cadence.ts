/**
 * Pure cadence math for the local scheduler (PRD §6 Phase 14).
 *
 * The scheduler ticks once a minute and asks {@link shouldFireNow} whether a
 * schedule's next fire is *due* relative to the current `now`. Keeping the math
 * pure + injectable means the scheduler can be unit-tested with a fast-forwarded
 * clock (PRD §6 Phase 14 Verify: "a schedule fires on cadence (fast-forwarded
 * clock in test)").
 *
 * Cadence semantics:
 *  - `cadence: "daily"`, `time: "HH:MM"` — fire once per server-local day at the
 *    given time. A schedule that has never fired is due as soon as `now` is on
 *    or past today's HH:MM. A schedule that *has* fired today is not due again
 *    until the next day's HH:MM.
 *  - `disabled` schedules are never due. The scheduler skips them entirely.
 */

import { isValidTime, type Schedule } from "@/lib/schedules/types";

/** Build the Date for "today's HH:MM" in the server-local timezone. */
function todayAt(time: string, now: Date): Date {
  const [hh, mm] = time.split(":");
  const fire = new Date(now);
  fire.setHours(Number(hh), Number(mm), 0, 0);
  return fire;
}

/**
 * The *most recent* HH:MM moment that is at or before `now`. For a daily
 * schedule this is the cutoff a schedule must have fired after to be considered
 * "already fired this cycle". If today's HH:MM is still in the future, the
 * cutoff rolls back to yesterday's.
 */
export function lastDueMoment(time: string, now: Date): Date {
  const todays = todayAt(time, now);
  if (todays.getTime() <= now.getTime()) return todays;
  const yesterdays = new Date(todays);
  yesterdays.setDate(yesterdays.getDate() - 1);
  return yesterdays;
}

/**
 * The *next* HH:MM moment strictly after `now` — what the UI displays as
 * "Next run". For daily this is today's HH:MM if still in the future, else
 * tomorrow's.
 */
export function nextFireAt(time: string, now: Date): Date {
  const todays = todayAt(time, now);
  if (todays.getTime() > now.getTime()) return todays;
  const tomorrows = new Date(todays);
  tomorrows.setDate(tomorrows.getDate() + 1);
  return tomorrows;
}

/**
 * Whether a daily `time` has an occurrence that `lastFiredAt` has not covered
 * yet, as of `now` — the cadence half of "is this due?", with the enabled and
 * cadence guards left to the caller.
 *
 * Split out of {@link shouldFireNow} so the Edit-schedule dialog can warn that a
 * time change will fire the schedule immediately using the very predicate the
 * scheduler will evaluate a minute later, instead of a second copy of the rule
 * that could drift from it. Moving a schedule's time *backwards* past a moment
 * that has already gone by today is exactly the case that trips people up: the
 * new cutoff is in the past and the last fire predates it, so the schedule is
 * due at once.
 *
 * A malformed time never fires, and an unparseable `lastFiredAt` is treated as
 * "never fired" — the same defensive reading the scheduler has always used.
 */
export function isDueAt(
  time: string,
  lastFiredAt: string | null,
  now: Date,
): boolean {
  if (!isValidTime(time)) return false;

  const cutoff = lastDueMoment(time, now);
  if (now.getTime() < cutoff.getTime()) return false;

  if (lastFiredAt === null) return true;
  const lastFired = new Date(lastFiredAt);
  if (Number.isNaN(lastFired.getTime())) return true;
  return lastFired.getTime() < cutoff.getTime();
}

/**
 * Decide whether `schedule` is due to fire at `now`.
 *
 * A schedule is due iff:
 *  - it is enabled,
 *  - its cadence/time are well-formed (defensive — bad rows simply never fire),
 *  - `now` is on or past the most recent cutoff (today's HH:MM, or yesterday's
 *    if today's is still ahead), AND
 *  - it has not already fired since that cutoff.
 *
 * Pure: takes the schedule + an injectable `now` and returns a boolean. The
 * scheduler is the only caller; tests drive it with synthetic `Date`s.
 */
export function shouldFireNow(schedule: Schedule, now: Date): boolean {
  if (!schedule.enabled) return false;
  if (schedule.cadence !== "daily") return false;
  return isDueAt(schedule.time, schedule.lastFiredAt, now);
}
