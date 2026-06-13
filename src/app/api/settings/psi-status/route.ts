/**
 * `GET /api/settings/psi-status` — report whether a PageSpeed Insights API key is
 * configured for this server, as a boolean ONLY.
 *
 * The settings UI uses this to show "PageSpeed Insights: Ready / Not configured"
 * in every run mode — the key may come from a dev `.env` (`next dev`/`next start`)
 * or be injected by the Electron main process from the OS keychain (packaged app).
 * Either way this endpoint never returns the key itself or any part of it; it only
 * reflects `getPsiApiKey()` presence so no secret crosses the wire.
 */

import { getPsiApiKey } from "@/lib/pagespeed/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ configured: getPsiApiKey() !== undefined }, { status: 200 });
}
