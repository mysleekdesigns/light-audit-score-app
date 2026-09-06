import { describe, expect, it } from "vitest";

import {
  parseCreateScheduleBody,
  parseUpdateScheduleBody,
} from "@/lib/api/schedules-schema";
import {
  DEFAULT_ALERT_DELTA,
  DEFAULT_SCHEDULE_NOTIFY,
  MAX_ALERT_DELTA,
  MIN_ALERT_DELTA,
} from "@/lib/alerts/types";
import { DEFAULT_OPTIONS } from "@/lib/lighthouse/options";
import { DEFAULT_THRESHOLDS } from "@/lib/settings/defaults";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "@/lib/queue/types";
import { MAX_SCHEDULE_URLS } from "@/lib/schedules/types";

const URL_TARGET = { kind: "urls" as const, urls: ["https://example.com"] };
const CRAWL_TARGET = {
  kind: "crawl" as const,
  spec: {
    url: "https://example.com",
    useSitemap: true,
    useCrawl: false,
    maxDepth: 2,
    maxPages: 25,
    excludePaths: [] as string[],
  },
};

describe("parseCreateScheduleBody — valid bodies", () => {
  it("resolves a minimal urls-target body with all defaults applied", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      name: "",
      enabled: true,
      cadence: "daily",
      time: "09:00",
      target: URL_TARGET,
      options: DEFAULT_OPTIONS,
      concurrency: DEFAULT_CONCURRENCY,
      // device defaults to options.formFactor (mobile by default).
      device: "mobile",
      accuracyMode: false,
      // source defaults to the local forked-Chrome engine.
      source: "local",
      // Regression alerts default to the disarmed factory config.
      notify: DEFAULT_SCHEDULE_NOTIFY,
    });
  });

  it("accepts a crawl target as-is and defaults excludePaths to []", () => {
    const result = parseCreateScheduleBody({
      time: "07:30",
      target: {
        kind: "crawl",
        spec: {
          url: "https://example.com",
          useSitemap: true,
          useCrawl: true,
          maxDepth: 1,
          maxPages: 10,
          // excludePaths omitted — schema default kicks in.
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.target).toEqual({
      kind: "crawl",
      spec: {
        url: "https://example.com",
        useSitemap: true,
        useCrawl: true,
        maxDepth: 1,
        maxPages: 10,
        excludePaths: [],
      },
    });
  });

  it("derives device from an explicit options.formFactor when device omitted", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
      options: { formFactor: "desktop" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.device).toBe("desktop");
  });

  it("preserves an explicit device:'both' (overrides the formFactor default)", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
      device: "both",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.device).toBe("both");
  });

  it("clamps an out-of-range concurrency", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
      concurrency: 999,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.concurrency).toBe(MAX_CONCURRENCY);
  });

  it("trims URL whitespace inside a urls target", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: { kind: "urls", urls: ["  https://example.com  "] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.target).toEqual({
      kind: "urls",
      urls: ["https://example.com"],
    });
  });

  it("accepts exactly MAX_SCHEDULE_URLS entries", () => {
    const urls = Array.from(
      { length: MAX_SCHEDULE_URLS },
      (_, i) => `https://example.com/${i}`,
    );
    const result = parseCreateScheduleBody({
      time: "00:00",
      target: { kind: "urls", urls },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.target.kind === "urls" && result.value.target.urls).toHaveLength(
      MAX_SCHEDULE_URLS,
    );
  });
});

describe("parseCreateScheduleBody — rejected bodies", () => {
  it("rejects a missing time field", () => {
    const result = parseCreateScheduleBody({ target: URL_TARGET });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "time")).toBe(true);
  });

  it("rejects a malformed time string", () => {
    const result = parseCreateScheduleBody({
      time: "9:00",
      target: URL_TARGET,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "time")).toBe(true);
  });

  it("rejects a time with out-of-range hours", () => {
    const result = parseCreateScheduleBody({
      time: "25:00",
      target: URL_TARGET,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "time")).toBe(true);
  });

  it("rejects a missing target field", () => {
    const result = parseCreateScheduleBody({ time: "09:00" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "target")).toBe(true);
  });

  it("rejects an empty urls list", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: { kind: "urls", urls: [] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path.startsWith("target"))).toBe(true);
  });

  it("rejects more than MAX_SCHEDULE_URLS entries", () => {
    const urls = Array.from(
      { length: MAX_SCHEDULE_URLS + 1 },
      (_, i) => `https://example.com/${i}`,
    );
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: { kind: "urls", urls },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-http(s) URL inside a urls target", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: { kind: "urls", urls: ["ftp://example.com"] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.toLowerCase().includes("http"))).toBe(
      true,
    );
  });

  it("rejects a crawl target with maxPages = 0", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: {
        kind: "crawl",
        spec: {
          url: "https://example.com",
          useSitemap: true,
          useCrawl: true,
          maxDepth: 1,
          maxPages: 0,
          excludePaths: [],
        },
      },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown target kind", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: { kind: "rss", urls: ["https://example.com"] },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object body without throwing", () => {
    expect(() => parseCreateScheduleBody("nonsense")).not.toThrow();
    expect(parseCreateScheduleBody("nonsense").ok).toBe(false);
  });

  it("rejects a non-numeric concurrency", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
      concurrency: "fast",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "concurrency")).toBe(true);
  });

  it("rejects an invalid device", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
      device: "tablet",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "device")).toBe(true);
  });
});

describe("parseUpdateScheduleBody — partial updates", () => {
  it("accepts an empty body", () => {
    const result = parseUpdateScheduleBody({});
    expect(result.ok).toBe(true);
  });

  it("accepts a pause patch (enabled:false carries through)", () => {
    const result = parseUpdateScheduleBody({ enabled: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.enabled).toBe(false);
  });

  it("accepts an enable patch", () => {
    const result = parseUpdateScheduleBody({ enabled: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.enabled).toBe(true);
  });

  it("carries a time update through", () => {
    const result = parseUpdateScheduleBody({ time: "23:45" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.time).toBe("23:45");
  });

  it("carries a target swap (urls → crawl) through", () => {
    const result = parseUpdateScheduleBody({ target: CRAWL_TARGET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.target).toEqual(CRAWL_TARGET);
  });

  it("derives device from options.formFactor when options is patched without device", () => {
    const result = parseUpdateScheduleBody({
      options: { formFactor: "desktop" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.device).toBe("desktop");
  });

  it("preserves an explicit device override even when options is patched", () => {
    const result = parseUpdateScheduleBody({
      options: { formFactor: "desktop" },
      device: "both",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.device).toBe("both");
  });

  it("rejects a malformed time on a partial patch", () => {
    const result = parseUpdateScheduleBody({ time: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "time")).toBe(true);
  });

  it("rejects a malformed target on a partial patch", () => {
    const result = parseUpdateScheduleBody({
      target: { kind: "urls", urls: [] },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object body without throwing", () => {
    expect(() => parseUpdateScheduleBody("nope")).not.toThrow();
    expect(parseUpdateScheduleBody("nope").ok).toBe(false);
  });
});

/**
 * Credentials on a schedule body (ROADMAP Phase B).
 *
 * The schedule schema reuses `auditOptionsSchema`, so a body may syntactically
 * carry credentials — but a schedule is never *stored* with them: it fires days
 * later with no batch in memory to re-attach anything from, so `src/lib/db/
 * schedules.ts` strips the fields at the persistence boundary (proved in
 * `src/lib/db/schedules.test.ts`) and the long-lived route is `.env`. These
 * tests pin that the validation layer stays permissive, so the strip is the one
 * place the rule lives.
 */
describe("schedule bodies — credentials", () => {
  const CREDENTIALS = {
    extraHeaders: { "X-Preview-Token": "preview-token-value" },
    basicAuth: { username: "staging", password: "staging-password" },
  };

  it("validates a credential-bearing body (the DB layer is what strips it)", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
      options: CREDENTIALS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.options.extraHeaders).toEqual(
      CREDENTIALS.extraHeaders,
    );
  });

  it("still rejects a malformed credential (bad header name)", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
      options: { extraHeaders: { "Bad Header": "value" } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path.startsWith("options"))).toBe(true);
  });
});

/**
 * Regression-alert preferences on a schedule body (ROADMAP Phase C).
 *
 * Two properties matter here. The config is *preference only* — a webhook URL or
 * any other credential-shaped field must never survive parsing, because the
 * destination is read from `.env` and Settings is read-only status
 * (`.claude/rules/security.md`). And the parsed value is run through
 * `sanitizeNotify`, so what the route echoes back is exactly what a later read
 * of the row returns.
 */
describe("schedule bodies — notify", () => {
  const FULL_NOTIFY = {
    enabled: true,
    categories: ["performance", "seo"],
    minDelta: 12,
    thresholds: { ...DEFAULT_THRESHOLDS, performance: 75 },
  };

  it("defaults to the disarmed factory config when notify is omitted", () => {
    const result = parseCreateScheduleBody({ time: "09:00", target: URL_TARGET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notify).toEqual(DEFAULT_SCHEDULE_NOTIFY);
    expect(result.value.notify!.enabled).toBe(false);
  });

  it("accepts a full notify config and returns it sanitized", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
      notify: FULL_NOTIFY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notify).toEqual({
      enabled: true,
      // Whitelisted back into canonical LIGHTHOUSE_CATEGORIES order.
      categories: ["performance", "seo"],
      minDelta: 12,
      thresholds: { ...DEFAULT_THRESHOLDS, performance: 75 },
    });
  });

  it("fills the gaps in a partial notify from the factory default", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
      notify: { enabled: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notify).toEqual({
      ...DEFAULT_SCHEDULE_NOTIFY,
      enabled: true,
    });
    expect(result.value.notify!.minDelta).toBe(DEFAULT_ALERT_DELTA);
  });

  it("upgrades a thresholds map missing a category rather than rejecting it", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
      notify: { thresholds: { performance: 50 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notify!.thresholds).toEqual({
      ...DEFAULT_THRESHOLDS,
      performance: 50,
    });
  });

  it("rejects a minDelta outside MIN..MAX", () => {
    for (const minDelta of [MIN_ALERT_DELTA - 1, MAX_ALERT_DELTA + 1, 2.5]) {
      const result = parseCreateScheduleBody({
        time: "09:00",
        target: URL_TARGET,
        notify: { minDelta },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.some((i) => i.path.startsWith("notify.minDelta"))).toBe(
        true,
      );
    }
  });

  it("rejects an unknown category and an out-of-range threshold", () => {
    const badCategory = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
      notify: { categories: ["not-a-category"] },
    });
    expect(badCategory.ok).toBe(false);

    const badThreshold = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
      notify: { thresholds: { performance: 900 } },
    });
    expect(badThreshold.ok).toBe(false);
  });

  it("never lets a credential-shaped field through", () => {
    const result = parseCreateScheduleBody({
      time: "09:00",
      target: URL_TARGET,
      notify: {
        enabled: true,
        webhookUrl: "https://hooks.example.test/services/T000/B000/xxxxxxxx",
        token: "alert-destination-token",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the four whitelisted preference fields survive.
    expect(Object.keys(result.value.notify!).sort()).toEqual([
      "categories",
      "enabled",
      "minDelta",
      "thresholds",
    ]);
    expect(JSON.stringify(result.value)).not.toContain("hooks.example.test");
    expect(JSON.stringify(result.value)).not.toContain("alert-destination-token");
  });

  it("a PATCH that omits notify leaves the key off the patch entirely", () => {
    const result = parseUpdateScheduleBody({ enabled: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Not `notify: DEFAULT` — the DB layer must keep whatever is stored.
    expect("notify" in result.value).toBe(false);
  });

  it("a PATCH that carries notify returns it sanitized", () => {
    const result = parseUpdateScheduleBody({ notify: { enabled: true } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notify).toEqual({
      ...DEFAULT_SCHEDULE_NOTIFY,
      enabled: true,
    });
  });
});
