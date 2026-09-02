/**
 * `GET /api/settings/research-status` — whether the AI analysis engine has a
 * research MCP server it can launch, through which one, and the state of the
 * CrawlForge switch. Booleans and a source name ONLY.
 *
 * Mirrors `psi-status`. A research server is SEPARATE software the user
 * installs and authenticates themselves; LightAudit only resolves whether one
 * is in reach. This endpoint resolves exactly what the analysis engine resolves,
 * so "Ready" here means the research tools will actually be available.
 *
 * It never returns a server's command, arguments, or environment — those can
 * carry the user's own credentials. Presence only.
 */

import { researchStatus } from "@/lib/analysis/providers/researchMcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(researchStatus(), { status: 200 });
}
