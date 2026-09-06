import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildWebhookPayload,
  deliverAlerts,
  getAlertWebhookUrl,
  isAlertWebhookConfigured,
  type AlertDeliveryContext,
} from "@/lib/alerts/deliver";
import type { ScheduleAlert } from "@/lib/alerts/types";

/**
 * A fake hook URL with several distinctive, independently searchable segments,
 * so the "never logged" assertions can look for the whole string *and* for the
 * token-shaped tail on its own.
 */
const HOOK = "https://hooks.slack.test/services/TZZZ1/BZZZ2/QQQsecretQQQ";
const HOOK_SECRET = "QQQsecretQQQ";

const CONTEXT: AlertDeliveryContext = {
  scheduleId: "sch_1",
  scheduleName: "Nightly homepage",
  batchId: "bat_new",
  priorBatchId: "bat_old",
};

function alert(patch: Partial<ScheduleAlert> = {}): ScheduleAlert {
  return {
    kind: "crossed_below",
    url: "https://a.example/",
    formFactor: "mobile",
    category: "performance",
    previous: 94,
    current: 71,
    delta: -23,
    threshold: 90,
    ...patch,
  };
}

function okResponse(status = 200): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getAlertWebhookUrl", () => {
  it("is null when unset or blank", () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", "");
    expect(getAlertWebhookUrl()).toBeNull();
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", "   ");
    expect(getAlertWebhookUrl()).toBeNull();
    expect(isAlertWebhookConfigured()).toBe(false);
  });

  it("returns the trimmed value for an http(s) URL", () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", `  ${HOOK}  `);
    expect(getAlertWebhookUrl()).toBe(HOOK);
    expect(isAlertWebhookConfigured()).toBe(true);

    vi.stubEnv("LH_ALERT_WEBHOOK_URL", "http://127.0.0.1:9000/hook");
    expect(getAlertWebhookUrl()).toBe("http://127.0.0.1:9000/hook");
  });

  it("rejects anything that is not an absolute http(s) URL", () => {
    for (const value of [
      "not a url",
      "/relative/hook",
      "hooks.slack.test/services/x",
      "ftp://hooks.slack.test/x",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      vi.stubEnv("LH_ALERT_WEBHOOK_URL", value);
      expect(getAlertWebhookUrl()).toBeNull();
      expect(isAlertWebhookConfigured()).toBe(false);
    }
  });

  it("is read at call time, not captured at import", () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", "");
    expect(getAlertWebhookUrl()).toBeNull();
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", HOOK);
    expect(getAlertWebhookUrl()).toBe(HOOK);
  });
});

describe("buildWebhookPayload", () => {
  it("puts the whole message in the plain-text fallback", () => {
    const payload = buildWebhookPayload(
      [
        alert(),
        alert({
          kind: "recovered_above",
          category: "seo",
          previous: 70,
          current: 92,
          delta: 22,
        }),
      ],
      CONTEXT,
    );
    const text = payload.text as string;
    expect(text).toContain("Nightly homepage");
    expect(text).toContain("2 alerts");
    expect(text).toContain("1 crossed below");
    expect(text).toContain("1 recovered");
    expect(text).toContain("Crossed below");
    expect(text).toContain("Performance 94 → 71 (-23)");
    expect(text).toContain("SEO 70 → 92 (+22)");
    expect(text).toContain("https://a.example/");
    expect(text).toContain("(mobile)");
  });

  it("singularises a lone alert", () => {
    const text = buildWebhookPayload([alert()], CONTEXT).text as string;
    expect(text).toContain("1 alert (");
  });

  it("renders Slack blocks that restate the fallback plus provenance", () => {
    const payload = buildWebhookPayload([alert()], CONTEXT);
    const blocks = payload.blocks as Array<Record<string, unknown>>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0]).toMatchObject({ type: "section" });
    expect((blocks[0].text as Record<string, unknown>).type).toBe("mrkdwn");

    const flattened = JSON.stringify(blocks);
    expect(flattened).toContain("Performance 94 → 71 (-23)");

    const context = blocks.at(-1) as Record<string, unknown>;
    expect(context.type).toBe("context");
    expect(JSON.stringify(context)).toContain("bat_new");
    expect(JSON.stringify(context)).toContain("bat_old");
    expect(JSON.stringify(context)).toContain("sch_1");
  });

  it("caps the listed alerts and counts the remainder", () => {
    const alerts = Array.from({ length: 25 }, (_, i) =>
      alert({ url: `https://a.example/page-${i}` }),
    );
    const text = buildWebhookPayload(alerts, CONTEXT).text as string;
    expect(text).toContain("25 alerts");
    expect(text).toContain("…and 15 more");
    expect(text).toContain("page-9");
    expect(text).not.toContain("page-10");
  });

  it("escapes Slack mrkdwn metacharacters coming from user data", () => {
    const payload = buildWebhookPayload(
      [alert({ url: "https://a.example/?a=1&b=<2>" })],
      { ...CONTEXT, scheduleName: "Tom & <Jerry>" },
    );
    const text = payload.text as string;
    expect(text).toContain("Tom &amp; &lt;Jerry&gt;");
    expect(text).toContain("&amp;b=&lt;2&gt;");
    expect(text).not.toMatch(/<Jerry>/);
  });

  it("falls back to a name when the schedule is unnamed", () => {
    const text = buildWebhookPayload([alert()], {
      ...CONTEXT,
      scheduleName: "   ",
    }).text as string;
    expect(text).toContain("Schedule");
  });

  it("stays well under the webhook body ceiling even with absurd input", () => {
    const alerts = Array.from({ length: 200 }, (_, i) =>
      alert({ url: `https://a.example/${"x".repeat(2_000)}/${i}` }),
    );
    const payload = buildWebhookPayload(alerts, CONTEXT);
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(40_000);
    expect(typeof payload.text).toBe("string");
  });
});

describe("deliverAlerts — short circuits", () => {
  it("does not attempt anything when there are no alerts", async () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", HOOK);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await deliverAlerts([], CONTEXT)).toEqual({
      attempted: false,
      delivered: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not attempt anything when no webhook is configured", async () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await deliverAlerts([alert()], CONTEXT)).toEqual({
      attempted: false,
      delivered: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns (without echoing the value) when the configured value is unusable", async () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", "definitely-not-a-url");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await deliverAlerts([alert()], CONTEXT)).toEqual({
      attempted: false,
      delivered: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("definitely-not-a-url");
  });
});

describe("deliverAlerts — the request", () => {
  it("POSTs JSON with a bounded timeout and reports success", async () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", HOOK);
    const fetchMock = vi.fn().mockResolvedValue(okResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverAlerts([alert()], CONTEXT);
    expect(result).toEqual({ attempted: true, delivered: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(HOOK);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual(buildWebhookPayload([alert()], CONTEXT));
  });

  it("treats a 2xx with no content as delivered", async () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", HOOK);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(204)));
    expect(await deliverAlerts([alert()], CONTEXT)).toEqual({
      attempted: true,
      delivered: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a non-ok response by status alone and never reads its body", async () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", HOOK);
    const text = vi.fn();
    const json = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, text, json } as unknown as Response),
    );

    expect(await deliverAlerts([alert()], CONTEXT)).toEqual({
      attempted: true,
      delivered: false,
      reason: "http 404",
    });
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("classifies a network throw, a timeout and an abort", async () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", HOOK);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    expect(await deliverAlerts([alert()], CONTEXT)).toEqual({
      attempted: true,
      delivered: false,
      reason: "network error",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(named("TimeoutError", "The operation was aborted due to timeout")),
    );
    expect(await deliverAlerts([alert()], CONTEXT)).toEqual({
      attempted: true,
      delivered: false,
      reason: "timeout",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(named("AbortError", "This operation was aborted")),
    );
    expect(await deliverAlerts([alert()], CONTEXT)).toEqual({
      attempted: true,
      delivered: false,
      reason: "aborted",
    });
  });

  it("never rejects, even on a malformed context or a non-Error throw", async () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", HOOK);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("a bare string"));
    expect(await deliverAlerts([alert()], CONTEXT)).toEqual({
      attempted: true,
      delivered: false,
      reason: "network error",
    });

    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const bad = { ...CONTEXT, scheduleName: 42 } as unknown as AlertDeliveryContext;
    expect(await deliverAlerts([alert()], bad)).toEqual({
      attempted: true,
      delivered: false,
      reason: "payload error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("deliverAlerts — the webhook URL never escapes", () => {
  /**
   * The load-bearing security property of this module: `fetch` puts the request
   * URL in the `cause` of the `TypeError` it throws, and a rejected webhook's
   * body routinely echoes the path back, so a careless `err.message` would write
   * a bearer credential into the log. Every failure path is exercised here and
   * every logged argument and returned value is searched for the URL.
   */
  const failures: Array<[string, unknown]> = [
    [
      "fetch failed with the URL in the cause",
      Object.assign(new TypeError(`fetch failed`), {
        cause: new Error(`connect ECONNREFUSED for ${HOOK}`),
      }),
    ],
    ["timeout", named("TimeoutError", `timed out posting to ${HOOK}`)],
    ["abort", named("AbortError", `aborted request to ${HOOK}`)],
    ["a thrown string containing the URL", `boom ${HOOK}`],
  ];

  for (const [label, thrown] of failures) {
    it(`keeps the URL out of logs and results — ${label}`, async () => {
      vi.stubEnv("LH_ALERT_WEBHOOK_URL", HOOK);
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(thrown));

      const result = await deliverAlerts([alert()], CONTEXT);
      expect(result.attempted).toBe(true);
      expect(result.delivered).toBe(false);

      const logged = warn.mock.calls.flat().map(String).join("\n");
      expect(logged).not.toContain(HOOK);
      expect(logged).not.toContain(HOOK_SECRET);
      expect(logged).not.toContain("hooks.slack.test");

      const returned = JSON.stringify(result);
      expect(returned).not.toContain(HOOK);
      expect(returned).not.toContain(HOOK_SECRET);
      expect(returned).not.toContain("hooks.slack.test");
    });
  }

  it("keeps the URL out of logs on a non-ok status", async () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", HOOK);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(403)));

    const result = await deliverAlerts([alert()], CONTEXT);
    expect(result.reason).toBe("http 403");

    const logged = warn.mock.calls.flat().map(String).join("\n");
    expect(logged).not.toContain(HOOK_SECRET);
    expect(logged).not.toContain("hooks.slack.test");
  });

  it("never logs the payload — the audited URLs are not a log's business", async () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", HOOK);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(500)));

    await deliverAlerts([alert({ url: "https://private.internal/secret-page" })], CONTEXT);
    const logged = warn.mock.calls.flat().map(String).join("\n");
    expect(logged).not.toContain("private.internal");
    expect(logged).not.toContain("secret-page");
    expect(logged).toContain("http 500");
  });

  it("never puts the URL in the payload it sends", async () => {
    vi.stubEnv("LH_ALERT_WEBHOOK_URL", HOOK);
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await deliverAlerts([alert()], CONTEXT);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).not.toContain(HOOK_SECRET);
  });
});


describe("mrkdwn markup from an audited URL (security review L1)", () => {
  /**
   * A crawl target's URL set comes from links and sitemap entries published by
   * the site under audit, so the URL is the one attacker-influenced field on an
   * alert line. These characters survive URL normalization and are Slack's
   * emphasis syntax.
   */
  const hostile =
    "https://evil.example/*bold*_italic_~strike~`code`";

  it("percent-encodes emphasis characters so a hostile URL cannot format the line", () => {
    const payload = buildWebhookPayload(
      [
        {
          kind: "crossed_below",
          url: hostile,
          formFactor: "mobile",
          category: "seo",
          previous: 95,
          current: 40,
          delta: -55,
          threshold: 90,
        },
      ],
      {
        scheduleId: "s1",
        scheduleName: "Nightly",
        batchId: "b2",
        priorBatchId: "b1",
      },
    );
    const text = payload.text as string;
    // The URL still appears, and still resolves to the same address...
    expect(text).toContain("https://evil.example/");
    expect(text).toContain("%2Abold%2A");
    expect(text).toContain("%5Fitalic%5F");
    expect(text).toContain("%7Estrike%7E");
    expect(text).toContain("%60code%60");
    // ...but carries none of the raw emphasis characters it arrived with.
    const line = text.split("\n").find((l) => l.includes("evil.example")) ?? "";
    expect(line).not.toMatch(/[*_~`]/);
  });

  it("is lossless: decoding the neutralized URL returns the original", () => {
    const payload = buildWebhookPayload(
      [
        {
          kind: "dropped_by",
          url: hostile,
          formFactor: "desktop",
          category: "performance",
          previous: 90,
          current: 70,
          delta: -20,
          threshold: null,
        },
      ],
      { scheduleId: "s", scheduleName: "n", batchId: "b", priorBatchId: "p" },
    );
    const line =
      (payload.text as string).split("\n").find((l) => l.includes("evil.example")) ?? "";
    const encoded = line.slice(line.indexOf("https://"), line.indexOf(" (desktop)"));
    expect(decodeURIComponent(encoded)).toBe(hostile);
  });

  it("percent-encodes newlines so a URL cannot forge an extra alert line", () => {
    // Alert lines are joined with "\n". A URL carrying one would appear to the
    // reader as an additional, entirely fabricated alert.
    const forging =
      "https://evil.example/x\nRecovered · https://real.example/ (mobile) — SEO 40 → 100 (+60)";
    const payload = buildWebhookPayload(
      [
        {
          kind: "crossed_below",
          url: forging,
          formFactor: "mobile",
          category: "seo",
          previous: 95,
          current: 40,
          delta: -55,
          threshold: 90,
        },
      ],
      { scheduleId: "s", scheduleName: "n", batchId: "b", priorBatchId: "p" },
    );
    const text = payload.text as string;
    const lines = text.split("\n");
    // One headline + exactly one alert line — not one plus a forged one.
    expect(lines).toHaveLength(2);
    expect(text).toContain("%0A");
    // The forged text is not censored — it is still part of the URL, and saying
    // so is more honest than silently editing the address. What matters is that
    // it can no longer BEGIN a line, which is what would make it read as a
    // separate alert: every line still starts with a real kind label.
    expect(lines[1].startsWith("Crossed below · ")).toBe(true);
    expect(lines.some((l) => l.startsWith("Recovered · "))).toBe(false);
  });

  it("still escapes the link-forgery characters", () => {
    const payload = buildWebhookPayload(
      [
        {
          kind: "crossed_below",
          url: "https://evil.example/<https://real.example|Looks fine>",
          formFactor: "mobile",
          category: "seo",
          previous: 95,
          current: 40,
          delta: -55,
          threshold: 90,
        },
      ],
      { scheduleId: "s", scheduleName: "n", batchId: "b", priorBatchId: "p" },
    );
    const text = payload.text as string;
    expect(text).not.toContain("<https://real.example|");
    expect(text).toContain("&lt;");
  });
});
