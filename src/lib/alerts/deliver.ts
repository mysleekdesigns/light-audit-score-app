/**
 * Webhook delivery for regression alerts (ROADMAP Phase C).
 *
 * Renders the {@link ScheduleAlert}s from `compare.ts` into a Slack-compatible
 * body and POSTs it to `LH_ALERT_WEBHOOK_URL`. Called by the scheduler right
 * after `recordScheduleFire`, on the tail of a batch that has already been
 * persisted — so this module's contract is that it **cannot** affect the batch:
 * it never throws, never rejects, and reports what happened by return value.
 *
 * ## Why the URL is in `.env` and nowhere else
 *
 * An incoming-webhook URL is a bearer credential wearing a URL's clothes: anyone
 * holding the string can post into the channel forever, and it never expires on
 * its own. So it is read from `process.env` at call time and, per
 * `.claude/rules/security.md`, never reaches SQLite, the `schedules` row, a
 * client payload, or a Settings form — Settings reports *presence* as a boolean
 * via {@link isAlertWebhookConfigured} and nothing more.
 *
 * That same rule is why the error handling below looks paranoid. `fetch` embeds
 * the full request URL in the `cause` of the `TypeError: fetch failed` it throws,
 * `AbortSignal.timeout` produces a `DOMException` whose message can carry it, and
 * a 4xx body from a webhook host routinely echoes the path back. Any of those,
 * logged or returned or re-thrown, would write the credential into a log file or
 * an error surface. So every failure is caught and reduced to a fixed, URL-free
 * phrase (`"http 404"`, `"timeout"`, `"network error"`), the response body is
 * never read, and the payload is never logged either — it contains the audited
 * URLs, which are the user's business and not a log's.
 */

import { alertKindLabel, alertSummary } from "@/lib/alerts/format";
import type { ScheduleAlert } from "@/lib/alerts/types";

/** The one environment variable this module reads. */
const WEBHOOK_ENV = "LH_ALERT_WEBHOOK_URL";

/**
 * Per-request ceiling. Slack's own incoming-webhook guidance is that a hook
 * answers in a second or two; 10s is generous enough to cover a slow hop while
 * still finishing long before the next scheduler tick a minute later.
 */
export const ALERT_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * How many alert lines the message spells out before collapsing the rest into an
 * "and N more" line. A regression that hits fifty URLs at once is one incident,
 * and pasting fifty lines into a channel buries it.
 */
const MAX_LISTED_ALERTS = 10;

/** Hard cap on a single rendered line — a pathological URL must not blow the body. */
const MAX_LINE_CHARS = 300;

/** Slack rejects a `section` block whose mrkdwn text exceeds 3000 characters. */
const MAX_SECTION_CHARS = 2_900;

/**
 * Total body ceiling. Slack accepts about 40KB on an incoming webhook; staying
 * under it deterministically is cheaper than discovering the limit as a 400.
 */
const MAX_PAYLOAD_BYTES = 40_000;

/**
 * The webhook URL from the environment, or `null`.
 *
 * Read at call time, never at module load: the scheduler is long-lived, tests
 * mutate `process.env` between cases, and a value captured at import would make
 * both of those lie. Anything that is not an absolute `http:`/`https:` URL is
 * rejected rather than half-trusted — a relative path or a `file:`/`javascript:`
 * scheme reaching `fetch` is a worse outcome than not alerting.
 */
export function getAlertWebhookUrl(): string | null {
  const raw = process.env[WEBHOOK_ENV]?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    // Not a parseable absolute URL. Never echo the value in a diagnostic.
    return null;
  }
  return raw;
}

/**
 * Presence as a boolean — exactly what a Settings status endpoint may report.
 * Deliberately the only thing about the webhook the UI can ever learn.
 */
export function isAlertWebhookConfigured(): boolean {
  return getAlertWebhookUrl() !== null;
}

/** Which fire produced these alerts — provenance for the message footer. */
export interface AlertDeliveryContext {
  scheduleId: string;
  scheduleName: string;
  batchId: string;
  priorBatchId: string;
}

/** Outcome of a delivery attempt. Never an exception. */
export interface AlertDeliveryResult {
  /** False when there was no webhook configured or no alerts to send. */
  attempted: boolean;
  delivered: boolean;
  /** Short, URL-free reason when `attempted && !delivered`. */
  reason?: string;
}

/**
 * Escape the three characters Slack's mrkdwn parser treats structurally. Applied
 * to whole composed lines rather than to each field: none of our own literals are
 * `&`, `<` or `>` (the score arrow is U+2192), so one pass cannot double-escape.
 *
 * This is what blocks the serious case — `<https://evil.example|Looks fine>`
 * link forgery. It deliberately does NOT touch the emphasis characters, because
 * the payload wraps its own headline in a literal `*…*`; those are handled at the
 * one field they can arrive from, in {@link neutralizeUrlMarkup}.
 */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Percent-encode the mrkdwn emphasis characters in an audited URL.
 *
 * Every other field on the line is ours or validated — the kind label and the
 * arrow are literals, the category is one of `LIGHTHOUSE_CATEGORIES`, the form
 * factor is one of two words, the scores are integers. The URL is not: a crawl
 * target takes its URL set from links and sitemap entries published by the site
 * under audit (`src/lib/crawl/discover.ts`), and `*`, `_`, `~` and a backtick all
 * survive WHATWG URL normalization. So a page an attacker controls can publish
 * `https://evil.example/*Nothing wrong here*` and have that render bold in the
 * channel — cosmetic spoofing of a line the user is reading to make a decision
 * (ROADMAP Phase C security review, L1).
 *
 * Percent-encoding rather than substitution or stripping, because for a URL it is
 * **lossless**: `%2A` is the same URL, it still resolves, and it is still
 * copy-pasteable. A lookalike character would silently change the address the
 * reader sees.
 */
function neutralizeUrlMarkup(url: string): string {
  return url
    .replace(/`/g, "%60")
    .replace(/\*/g, "%2A")
    .replace(/_/g, "%5F")
    .replace(/~/g, "%7E")
    // A newline is worse than emphasis: the payload joins alert lines with "\n",
    // so one embedded here forges a whole additional line the reader takes for a
    // real alert. `new URL()` strips these while parsing but `httpUrlSchema`
    // persists the raw string, so a URL reaching us can still carry them.
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

/** Clip a string to `max` characters, marking that it was clipped. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * One alert as a line: kind, what changed, and on which URL/device.
 *
 * The kind leads because it is what decides whether the reader needs to act now;
 * {@link alertSummary} supplies the numbers so the webhook and the in-app strip
 * cannot word the same event two ways.
 */
function renderAlertLine(alert: ScheduleAlert): string {
  const url = neutralizeUrlMarkup(alert.url);
  const line = `${alertKindLabel(alert.kind)} · ${url} (${alert.formFactor}) — ${alertSummary(alert)}`;
  return truncate(line, MAX_LINE_CHARS);
}

/** `2 crossed below, 1 dropped, 1 recovered` — only the kinds actually present. */
function describeCounts(alerts: readonly ScheduleAlert[]): string {
  const counts = {
    crossed_below: 0,
    dropped_by: 0,
    recovered_above: 0,
  };
  for (const alert of alerts) {
    // `Object.hasOwn`, not `in`: `in` walks the prototype, so a kind of
    // "constructor" would create an own property here instead of being ignored.
    if (Object.hasOwn(counts, alert.kind)) counts[alert.kind] += 1;
  }
  const parts: string[] = [];
  if (counts.crossed_below > 0) parts.push(`${counts.crossed_below} crossed below`);
  if (counts.dropped_by > 0) parts.push(`${counts.dropped_by} dropped`);
  if (counts.recovered_above > 0) parts.push(`${counts.recovered_above} recovered`);
  return parts.join(", ");
}

/**
 * Slack-compatible body: a plain-text fallback plus block detail.
 *
 * Top-level `text` carries the whole message on its own, because it is the only
 * field every consumer honours — Slack's notification preview and mobile push,
 * Discord's `/slack` compatibility endpoint, and any homemade receiver that just
 * logs the field. `blocks` then renders the same content richly for Slack
 * proper. Nothing is said in one that is not said in the other, so a client that
 * ignores blocks loses formatting and no information.
 *
 * Pure: takes alerts + context, returns data. Exported separately from
 * {@link deliverAlerts} so the body can be asserted in tests without a network
 * stub — and so a future second transport renders identically.
 */
export function buildWebhookPayload(
  alerts: readonly ScheduleAlert[],
  context: AlertDeliveryContext,
): Record<string, unknown> {
  const name = context.scheduleName?.trim() || "Schedule";
  const headline = truncate(
    `LightAudit Score · ${name}: ${alerts.length} alert${alerts.length === 1 ? "" : "s"}` +
      (alerts.length > 0 ? ` (${describeCounts(alerts)})` : ""),
    MAX_LINE_CHARS,
  );

  const listed = alerts.slice(0, MAX_LISTED_ALERTS).map(renderAlertLine);
  const hidden = alerts.length - listed.length;
  if (hidden > 0) listed.push(`…and ${hidden} more`);

  const text = escapeMrkdwn([headline, ...listed].join("\n"));
  const detail = truncate(escapeMrkdwn(listed.join("\n")), MAX_SECTION_CHARS);
  const footer = truncate(
    escapeMrkdwn(
      `batch ${context.batchId} · compared with ${context.priorBatchId} · schedule ${context.scheduleId}`,
    ),
    MAX_SECTION_CHARS,
  );

  const payload: Record<string, unknown> = {
    text,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${escapeMrkdwn(headline)}*` },
      },
      ...(detail
        ? [{ type: "section", text: { type: "mrkdwn", text: detail } }]
        : []),
      { type: "context", elements: [{ type: "mrkdwn", text: footer }] },
    ],
  };

  // Last-resort ceiling. `blocks` restate `text`, so dropping them halves the
  // body without losing a word — and `text` is already line- and count-capped.
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) {
    return { text: truncate(text, MAX_SECTION_CHARS) };
  }
  return payload;
}

/**
 * Reduce a thrown value to a fixed phrase.
 *
 * The thrown object is never inspected for a message, only for a name: `fetch`'s
 * `TypeError` carries the request URL in `cause`, and a `DOMException` from an
 * abort can carry it too. Names are a closed set we control; messages are not.
 */
function classifyThrow(error: unknown): string {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  if (name === "TimeoutError") return "timeout";
  if (name === "AbortError") return "aborted";
  return "network error";
}

/**
 * POST the alerts to the configured webhook.
 *
 * Never throws. Never rejects. Logs a URL-free warning and swallows.
 *
 * `attempted: false` covers the two "nothing to do" cases — no alerts, or no
 * webhook configured — so the caller can tell "we tried and the hook was down"
 * apart from "this install doesn't use a hook" without inspecting the
 * environment itself.
 */
export async function deliverAlerts(
  alerts: readonly ScheduleAlert[],
  context: AlertDeliveryContext,
): Promise<AlertDeliveryResult> {
  if (!alerts || alerts.length === 0) {
    return { attempted: false, delivered: false };
  }

  const url = getAlertWebhookUrl();
  if (url === null) {
    // Distinguish "not configured" (silent, the norm) from "configured wrongly"
    // (worth saying once per fire), without ever printing the offending value.
    if (process.env[WEBHOOK_ENV]?.trim()) {
      console.warn(
        `[alerts] ${WEBHOOK_ENV} is set but is not an absolute http(s) URL — alerts were not delivered`,
      );
    }
    return { attempted: false, delivered: false };
  }

  let body: string;
  try {
    body = JSON.stringify(buildWebhookPayload(alerts, context));
  } catch {
    console.warn("[alerts] webhook delivery failed: payload error");
    return { attempted: true, delivered: false, reason: "payload error" };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(ALERT_DELIVERY_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = classifyThrow(error);
    console.warn(`[alerts] webhook delivery failed: ${reason}`);
    return { attempted: true, delivered: false, reason };
  }

  if (response.ok) return { attempted: true, delivered: true };

  // Status only — the body of a rejected webhook request routinely echoes the
  // URL back, so it is never read.
  // Never READ the body — it can echo the URL back at us, and this module's
  // whole contract is that the URL reaches no log line. But an unconsumed body
  // holds the socket open under undici until GC, so cancel it explicitly:
  // discarding is not the same as ignoring.
  void response.body?.cancel();
  const reason = `http ${response.status}`;
  console.warn(`[alerts] webhook delivery failed: ${reason}`);
  return { attempted: true, delivered: false, reason };
}
