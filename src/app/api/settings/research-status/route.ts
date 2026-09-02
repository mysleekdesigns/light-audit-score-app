/**
 * `GET /api/settings/research-status` — report whether the AI analysis engine has
 * a research MCP server it can launch, as a boolean ONLY.
 *
 * Mirrors `psi-status`. The research server is a SEPARATE application the user
 * installs and configures themselves; LightAudit only reads a standard MCP config
 * to find it. This endpoint resolves exactly what the analysis engine resolves, so
 * "Ready" here means the research tools will actually be available.
 *
 * It never returns the server's command, arguments, or environment — those can
 * carry the user's own credentials. Presence only.
 */

import { loadResearchMcpConfig } from "@/lib/analysis/providers/researchMcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ configured: loadResearchMcpConfig() !== null }, { status: 200 });
}
