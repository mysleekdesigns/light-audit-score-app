/**
 * `GET /api/settings/alert-status` — whether a regression-alert webhook is
 * configured. A single boolean, and nothing else, ever.
 *
 * Mirrors `psi-status` and `research-status`. A Slack/Discord webhook URL is
 * credential-shaped: anyone holding it can post into the channel. It is read
 * from `process.env.LH_ALERT_WEBHOOK_URL` by the delivery layer and must never
 * reach the client — not the value, not its host, not its length, not a masked
 * prefix. `isAlertWebhookConfigured()` resolves exactly what delivery resolves,
 * so "Ready" here means an alert really would be posted.
 *
 * The in-app alert strip on the Archive page works with no webhook at all, so
 * `configured: false` is a supported configuration rather than an error state.
 */

import { isAlertWebhookConfigured } from "@/lib/alerts/deliver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ configured: isAlertWebhookConfigured() }, { status: 200 });
}
