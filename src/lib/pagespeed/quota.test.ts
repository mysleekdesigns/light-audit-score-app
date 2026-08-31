import { describe, expect, it } from "vitest";

import {
  PSI_REQUESTS_PER_MINUTE,
  psiRequestCost,
} from "@/lib/pagespeed/quota";

describe("psiRequestCost", () => {
  it("charges one call per run on a single strategy", () => {
    expect(psiRequestCost("mobile", 3, 4)).toMatchObject({
      strategies: 1,
      perUrl: 3,
      total: 12,
      overBurst: false,
    });
  });

  it("doubles the per-URL cost for `both` (mobile + desktop jobs)", () => {
    expect(psiRequestCost("both", 3, 4)).toMatchObject({
      strategies: 2,
      perUrl: 6,
      total: 24,
    });
  });

  it("prices a run before any target is pasted", () => {
    // The form shows `perUrl` while `targets` is still 0, so it must survive.
    expect(psiRequestCost("desktop", 5, 0)).toMatchObject({
      perUrl: 5,
      total: 0,
      overBurst: false,
    });
  });

  it("flags a batch only once it passes the per-minute burst ceiling", () => {
    const atLimit = psiRequestCost("mobile", 1, PSI_REQUESTS_PER_MINUTE);
    expect(atLimit.total).toBe(PSI_REQUESTS_PER_MINUTE);
    expect(atLimit.overBurst).toBe(false);

    expect(psiRequestCost("mobile", 1, PSI_REQUESTS_PER_MINUTE + 1).overBurst).toBe(
      true,
    );
  });

  it("clamps nonsense counts to zero rather than propagating NaN", () => {
    expect(psiRequestCost("mobile", Number.NaN, 4).total).toBe(0);
    expect(psiRequestCost("mobile", 3, -2).total).toBe(0);
  });
});
