/**
 * Tests for the in-flight audit registry (ROADMAP Phase G security re-review, L4).
 *
 * The behaviour being pinned is a shutdown path, which is exactly the kind that
 * is never exercised by hand: a client restarting the server mid-audit used to
 * orphan a headless Chrome, and nobody would notice except as a stray process.
 * So the cases here are about the unhappy shapes — a cancel that throws, a
 * double-cancel, an empty registry — because the happy one is trivial and the
 * others are what a shutdown actually meets.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activeBatchIds,
  cancelActiveBatches,
  trackBatch,
  untrackBatch,
} from "@/lib/mcp/activeBatches";

const cancelBatch = vi.fn();

vi.mock("@/lib/queue/AuditQueue", () => ({
  getAuditQueue: () => ({ cancelBatch }),
}));

afterEach(() => {
  cancelActiveBatches();
  cancelBatch.mockReset();
});

describe("activeBatches", () => {
  it("tracks and untracks a batch", () => {
    trackBatch("batch-1");
    expect(activeBatchIds()).toEqual(["batch-1"]);
    untrackBatch("batch-1");
    expect(activeBatchIds()).toEqual([]);
  });

  it("cancels everything in flight and empties the registry", () => {
    trackBatch("batch-1");
    trackBatch("batch-2");
    expect(cancelActiveBatches()).toBe(2);
    expect(cancelBatch).toHaveBeenCalledWith("batch-1");
    expect(cancelBatch).toHaveBeenCalledWith("batch-2");
    expect(activeBatchIds()).toEqual([]);
  });

  it("does not touch the queue when nothing is in flight", () => {
    // The common case on shutdown, and it must not construct a queue — building
    // one on the way out of the process would open the database to cancel
    // nothing.
    expect(cancelActiveBatches()).toBe(0);
    expect(cancelBatch).not.toHaveBeenCalled();
  });

  it("keeps going when one cancellation throws", () => {
    // This runs while the process is exiting: a throw here would replace an
    // orderly shutdown with a stack trace AND leave the remaining children
    // running, which is the failure it exists to prevent.
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    cancelBatch.mockImplementationOnce(() => {
      throw new Error("queue is gone");
    });
    trackBatch("batch-1");
    trackBatch("batch-2");

    expect(cancelActiveBatches()).toBe(1);
    expect(cancelBatch).toHaveBeenCalledTimes(2);
    expect(activeBatchIds()).toEqual([]);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("is idempotent", () => {
    trackBatch("batch-1");
    expect(cancelActiveBatches()).toBe(1);
    expect(cancelActiveBatches()).toBe(0);
  });
});
