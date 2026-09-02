/**
 * `GET|PUT /api/settings/crawlforge` — the CrawlForge research-server switch.
 *
 * `PUT { "enabled": boolean }` stores the user's preference in `app_settings`
 * and answers with the full research status, so the panel can show what the
 * next analysis will actually do (enabled is not the same as active: a key
 * still has to be in reach). `GET` is the same status without a write.
 *
 * This is the only settings endpoint that writes anything, and what it writes
 * is a boolean preference. It never accepts, stores, or echoes a key: the
 * CrawlForge key lives in the user's `.env` or in CrawlForge's own config, and
 * is reported as present/absent only.
 */

import { z } from "zod";

import { setCrawlforgeEnabled } from "@/lib/analysis/providers/crawlforge";
import { researchStatus } from "@/lib/analysis/providers/researchMcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ enabled: z.boolean() });

export async function GET(): Promise<Response> {
  return Response.json(researchStatus(), { status: 200 });
}

export async function PUT(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'Expected a body of the form { "enabled": true | false }.' },
      { status: 400 },
    );
  }

  try {
    setCrawlforgeEnabled(parsed.data.enabled);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[settings] could not save the CrawlForge switch: ${message}`);
    return Response.json(
      { error: "Could not save the setting. Check that the data directory is writable." },
      { status: 500 },
    );
  }

  return Response.json(researchStatus(), { status: 200 });
}
