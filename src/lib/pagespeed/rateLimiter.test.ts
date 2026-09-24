import { describe, expect, it, vi } from "vitest";

import {
  abortableDelay,
  PSI_RATE_WINDOW_MS,
  PsiRateLimiter,
} from "@/lib/pagespeed/rateLimiter";

/** A manual clock whose `sleep` advances time instead of waiting on it. */
function makeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
    sleep: vi.fn(async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      sleeps.push(ms);
      now += ms;
    }),
  };
  return clock;
}

function makeLimiter(clock: ReturnType<typeof makeClock>, limit: number) {
  return new PsiRateLimiter({
    limitPerMinute: () => limit,
    now: clock.now,
    sleep: clock.sleep,
    jitter: () => 0,
  });
}

describe("PsiRateLimiter", () => {
  it("admits requests immediately while the window has room", async () => {
    const clock = makeClock();
    const limiter = makeLimiter(clock, 3);

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("waits for the oldest admission to leave the window once the limit is reached", async () => {
    const clock = makeClock();
    const limiter = makeLimiter(clock, 2);

    await limiter.acquire();
    clock.advance(10_000);
    await limiter.acquire();
    // Window is full: the third request waits until the first is 60s old.
    await limiter.acquire();

    expect(clock.sleeps).toEqual([PSI_RATE_WINDOW_MS - 10_000]);
  });

  it("pauses every caller for a cooldown, which only ever extends", async () => {
    const clock = makeClock();
    const limiter = makeLimiter(clock, 100);

    limiter.cooldown(15_000);
    limiter.cooldown(5_000);
    expect(limiter.pausedFor()).toBe(15_000);

    await limiter.acquire();

    expect(clock.sleeps).toEqual([15_000]);
    expect(limiter.pausedFor()).toBe(0);
  });

  it("ignores a non-positive or non-finite cooldown", () => {
    const clock = makeClock();
    const limiter = makeLimiter(clock, 100);

    limiter.cooldown(0);
    limiter.cooldown(-5);
    limiter.cooldown(Number.NaN);
    limiter.cooldown(Number.POSITIVE_INFINITY);

    expect(limiter.pausedFor()).toBe(0);
  });

  it("re-checks after sleeping so a cooldown that lands mid-wait is honoured", async () => {
    const clock = makeClock();
    const limiter = makeLimiter(clock, 1);
    await limiter.acquire();

    // While the second caller waits on the window, a 429 elsewhere cools down.
    clock.sleep.mockImplementationOnce(async (ms: number) => {
      clock.sleeps.push(ms);
      clock.advance(ms);
      limiter.cooldown(5_000);
    });

    await limiter.acquire();

    expect(clock.sleeps).toEqual([PSI_RATE_WINDOW_MS, 5_000]);
  });

  it("adds jitter to each wait", async () => {
    const clock = makeClock();
    const limiter = new PsiRateLimiter({
      limitPerMinute: () => 1,
      now: clock.now,
      sleep: clock.sleep,
      jitter: () => 100,
    });

    await limiter.acquire();
    await limiter.acquire();

    expect(clock.sleeps).toEqual([PSI_RATE_WINDOW_MS + 100]);
  });

  it("rejects with the signal's reason instead of waiting when aborted", async () => {
    const clock = makeClock();
    const limiter = makeLimiter(clock, 1);
    await limiter.acquire();

    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));

    await expect(limiter.acquire(controller.signal)).rejects.toThrow(
      "user cancelled",
    );
    expect(clock.sleep).not.toHaveBeenCalled();
  });
});

describe("abortableDelay", () => {
  it("resolves after the delay", async () => {
    await expect(abortableDelay(5)).resolves.toBeUndefined();
  });

  it("rejects with the abort reason when the signal fires mid-wait", async () => {
    const controller = new AbortController();
    const pending = abortableDelay(10_000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});
