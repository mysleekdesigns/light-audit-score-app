/**
 * Next.js startup hook (PRD §6 Phase 14).
 *
 * Starts the local scheduler once per server process so saved schedules fire on
 * cadence without an HTTP request to wake them. Node runtime only — the Edge
 * runtime can't reach SQLite / chrome-launcher and never imports the queue.
 *
 * The scheduler is a `globalThis`-pinned singleton (mirroring `AuditQueue` /
 * the DB client) so this `register()` re-running on Next dev-mode HMR is a
 * no-op, not a duplicate interval.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Disable the scheduler entirely in unit tests (`vitest` sets NODE_ENV=test).
  if (process.env.LH_SCHEDULER_DISABLED === "1") return;
  const { getScheduler } = await import("@/lib/schedules/scheduler");
  getScheduler().start();
}
