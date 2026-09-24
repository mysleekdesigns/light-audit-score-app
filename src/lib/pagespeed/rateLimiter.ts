/**
 * Process-wide pacing for PageSpeed Insights calls.
 *
 * Google enforces a per-project "Queries per minute" quota on the PSI API and
 * answers HTTP 429 the instant it is exceeded — regardless of how many audit
 * jobs the queue is running in parallel. Every PSI request therefore passes
 * through ONE limiter, shared by all concurrent jobs, that does two things:
 *
 *  1. **Paces** requests under a per-minute ceiling (sliding 60s window), so a
 *     large batch cannot outrun a known quota. The ceiling is
 *     {@link getPsiRequestsPerMinute} (`PAGESPEED_REQUESTS_PER_MINUTE`, default
 *     Google's documented 240).
 *  2. **Cools down** on a 429: {@link PsiRateLimiter.cooldown} pauses EVERY
 *     caller — not just the one that was rejected — so the other concurrent jobs
 *     stop feeding an already-exhausted window and retrying in lockstep against
 *     it. The next attempt waits the cooldown out inside `acquire()`.
 *
 * Time, sleeping and jitter are injectable so the class is deterministic under
 * test; the process singleton lives behind {@link getPsiRateLimiter}.
 */

import { getPsiRequestsPerMinute } from "@/lib/pagespeed/config";

/** Google's quota window: "Queries per minute". */
export const PSI_RATE_WINDOW_MS = 60_000;

/** Upper bound of the random jitter added to every wait, so concurrent waiters
 * do not all wake and fire on the same tick when a window or cooldown opens. */
const MAX_JITTER_MS = 250;

/** Abortable sleep — rejects (so a retry loop unwinds) if `signal` fires mid-wait. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    };
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface PsiRateLimiterOptions {
  /** Requests admitted per {@link PSI_RATE_WINDOW_MS}; read on every acquire so
   * a config change applies without rebuilding the limiter. */
  limitPerMinute: () => number;
  /** Clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
  /** Sleep primitive. Defaults to {@link abortableDelay}. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Extra milliseconds added to each wait. Defaults to random `[0, 250)`. */
  jitter?: () => number;
}

export class PsiRateLimiter {
  private readonly limitPerMinute: () => number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly jitter: () => number;
  /** Start times (ascending) of requests admitted inside the current window. */
  private readonly started: number[] = [];
  /** Epoch ms until which every caller must wait (0 = open). */
  private pausedUntil = 0;

  constructor(options: PsiRateLimiterOptions) {
    this.limitPerMinute = options.limitPerMinute;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableDelay;
    this.jitter = options.jitter ?? (() => Math.random() * MAX_JITTER_MS);
  }

  /** Milliseconds the limiter is still paused for (0 when open). */
  pausedFor(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }

  /**
   * Pause EVERY caller for `ms` from now. A shorter cooldown never cuts an
   * existing one short — the latest 429 knows at least as much as the previous.
   */
  cooldown(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  /**
   * Resolve once a request may be sent: after any cooldown, and once the window
   * has room. Re-checks after every sleep, because a cooldown can land while a
   * caller is waiting on the window. Rejects with the signal's reason on abort.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const now = this.now();
      this.prune(now);
      const wait = this.waitFor(now);
      if (wait <= 0) {
        this.started.push(now);
        return;
      }
      await this.sleep(wait + this.jitter(), signal);
    }
  }

  /** Drop admissions older than one window. */
  private prune(now: number): void {
    const cutoff = now - PSI_RATE_WINDOW_MS;
    while (this.started.length > 0 && this.started[0] <= cutoff) {
      this.started.shift();
    }
  }

  /** Milliseconds until the next request may go (0 = now). */
  private waitFor(now: number): number {
    if (now < this.pausedUntil) return this.pausedUntil - now;
    const limit = Math.max(1, Math.floor(this.limitPerMinute()));
    if (this.started.length < limit) return 0;
    return this.started[0] + PSI_RATE_WINDOW_MS - now;
  }
}

let singleton: PsiRateLimiter | undefined;

/** The one limiter every PSI request in this process goes through. */
export function getPsiRateLimiter(): PsiRateLimiter {
  singleton ??= new PsiRateLimiter({ limitPerMinute: getPsiRequestsPerMinute });
  return singleton;
}

/** Discard the shared limiter (its window and any cooldown). For tests. */
export function resetPsiRateLimiter(): void {
  singleton = undefined;
}
