import { describe, expect, it } from "vitest";

import type { HistoryRow } from "@/lib/db/persistence";
import type { AuditSource, FormFactor } from "@/lib/lighthouse/types";
import { collapseRuns } from "@/lib/history/collapse";

/**
 * Build a minimal {@link HistoryRow} for the projection tests. Only the fields
 * `collapseRuns` reads (id, url, source, formFactor, status, scores, createdAt)
 * matter; the rest are filled with inert defaults and cast.
 */
function row(
  partial: {
    id: string;
    url: string;
    createdAt: string;
    status?: "done" | "error";
    source?: AuditSource;
    formFactor?: FormFactor;
    performance?: number | null;
  },
): HistoryRow {
  const {
    id,
    url,
    createdAt,
    status = "done",
    source = "local",
    formFactor = "mobile",
    performance = 90,
  } = partial;
  return {
    id,
    batchId: `batch-${id}`,
    url,
    finalUrl: null,
    status,
    errorMessage: status === "error" ? "boom" : null,
    formFactor,
    source,
    runs: 1,
    options: {} as HistoryRow["options"],
    scores: { performance },
    metrics: null,
    field: null,
    environment: null,
    hasJsonReport: false,
    hasHtmlReport: false,
    fetchTime: null,
    createdAt,
  } as HistoryRow;
}

describe("collapseRuns", () => {
  it("collapses repeated runs of one page to its latest run", () => {
    const older = row({ id: "1", url: "https://a.com", createdAt: "2026-01-01" });
    const newer = row({ id: "2", url: "https://a.com", createdAt: "2026-02-01" });
    const result = collapseRuns([newer, older]);

    expect(result).toHaveLength(1);
    expect(result[0].latest).toBe(newer);
    expect(result[0].previous).toBe(older);
    expect(result[0].runCount).toBe(2);
  });

  it("picks the latest regardless of input order", () => {
    const a = row({ id: "1", url: "https://a.com", createdAt: "2026-01-01" });
    const b = row({ id: "2", url: "https://a.com", createdAt: "2026-03-01" });
    const c = row({ id: "3", url: "https://a.com", createdAt: "2026-02-01" });
    const [entry] = collapseRuns([a, b, c]);

    expect(entry.latest).toBe(b);
    expect(entry.previous).toBe(c); // most recent *earlier* run
    expect(entry.runCount).toBe(3);
  });

  it("leaves previous null for a first/only run", () => {
    const only = row({ id: "1", url: "https://a.com", createdAt: "2026-01-01" });
    const [entry] = collapseRuns([only]);

    expect(entry.latest).toBe(only);
    expect(entry.previous).toBeNull();
    expect(entry.runCount).toBe(1);
  });

  it("skips failed runs when choosing the previous comparable run", () => {
    const done = row({ id: "1", url: "https://a.com", createdAt: "2026-01-01" });
    const failed = row({ id: "2", url: "https://a.com", createdAt: "2026-02-01", status: "error" });
    const latest = row({ id: "3", url: "https://a.com", createdAt: "2026-03-01" });
    const [entry] = collapseRuns([latest, failed, done]);

    expect(entry.latest).toBe(latest);
    // The immediately-previous run errored, so we diff against the last *done* one.
    expect(entry.previous).toBe(done);
    expect(entry.runCount).toBe(3);
  });

  it("keeps the latest even when it failed (no comparable previous)", () => {
    const done = row({ id: "1", url: "https://a.com", createdAt: "2026-01-01" });
    const failed = row({ id: "2", url: "https://a.com", createdAt: "2026-02-01", status: "error" });
    const [entry] = collapseRuns([failed, done]);

    expect(entry.latest).toBe(failed);
    expect(entry.previous).toBe(done);
  });

  it("treats different devices, engines, and URLs as separate series", () => {
    const rows = [
      row({ id: "m", url: "https://a.com", createdAt: "2026-01-01", formFactor: "mobile" }),
      row({ id: "d", url: "https://a.com", createdAt: "2026-01-01", formFactor: "desktop" }),
      row({ id: "psi", url: "https://a.com", createdAt: "2026-01-01", source: "psi" }),
      row({ id: "b", url: "https://b.com", createdAt: "2026-01-01" }),
    ];
    const result = collapseRuns(rows);

    expect(result).toHaveLength(4);
    expect(result.every((entry) => entry.runCount === 1)).toBe(true);
  });

  it("returns an empty array for no rows", () => {
    expect(collapseRuns([])).toEqual([]);
  });
});
