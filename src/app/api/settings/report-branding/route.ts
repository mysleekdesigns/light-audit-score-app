/**
 * `GET|PUT /api/settings/report-branding` — the optional header block printed
 * at the top of an exported client report (ROADMAP Phase H).
 *
 * `GET` answers with the stored {@link ReportBranding}; `PUT` replaces it and
 * answers with what was ACTUALLY stored, which is the point of the endpoint
 * rather than a nicety. The store's allow-list can refuse a logo the browser
 * was happy to read — an SVG, an oversized file — and the user needs to see
 * that before they mail the report, not after. So the panel repaints from the
 * response instead of from what it hoped it sent.
 *
 * Nothing here is a credential. It stores a name, a strapline, a `data:` image
 * and a boolean into `app_settings`, which is where non-secret preferences live
 * (`.claude/rules/security.md`); anything credential-shaped stays in `.env` and
 * is never accepted by a settings route. Error bodies are fixed strings — no
 * request data is reflected back, so a hostile body cannot use this endpoint as
 * an echo.
 *
 * It needs no auth of its own: `src/proxy.ts` gates every route on the
 * per-install session token and refuses non-loopback `Host` headers.
 */

import { z } from "zod";

import {
  BRANDING_LOGO_MAX_BYTES,
  getReportBranding,
  setReportBranding,
} from "@/lib/settings/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hard bound on a submitted text field, well above the 80/160 the store keeps.
 * The store truncates rather than rejects, so this is not the display limit —
 * it is the point past which a body is plainly not the settings panel talking.
 */
const MAX_TEXT_FIELD = 4096;

/**
 * Hard bound on the submitted logo string: base64 is four characters per three
 * bytes, plus room for the `data:image/...;base64,` prefix. A logo over the
 * store's byte cap still parses (and comes back as `""`, which the panel shows);
 * this only stops a body that could not be a logo at all from being buffered.
 */
const MAX_LOGO_STRING = Math.ceil((BRANDING_LOGO_MAX_BYTES / 3) * 4) + 64;

/**
 * Every field optional: `PUT` is a full replacement, so an omitted field means
 * "unset", which is exactly what the sanitiser's defaults already say. Bounds
 * here are about the size of the request; VALIDITY is the store's decision, and
 * making it there keeps one field's rejection from discarding the others.
 */
const BodySchema = z.object({
  title: z.string().max(MAX_TEXT_FIELD).optional(),
  subtitle: z.string().max(MAX_TEXT_FIELD).optional(),
  logoDataUri: z.string().max(MAX_LOGO_STRING).optional(),
  showDate: z.boolean().optional(),
});

/** A 4xx with a fixed message. Never carries anything the caller sent. */
function refuse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

export async function GET(): Promise<Response> {
  return Response.json(getReportBranding(), { status: 200 });
}

export async function PUT(request: Request): Promise<Response> {
  // Refuse an oversized body before buffering it. `Content-Length` is absent on
  // a chunked request, in which case the schema's own bounds are what apply.
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOGO_STRING + 8192) {
    return refuse(413, "That logo is too large. Use an image under 256 KB.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse(400, "Request body must be JSON.");
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return refuse(
      400,
      'Expected a body of the form { "title"?: string, "subtitle"?: string, "logoDataUri"?: string, "showDate"?: boolean }.',
    );
  }

  try {
    // Answer with what was stored, not with what was sent: a rejected logo has
    // to be visible in the panel rather than only in the exported file.
    return Response.json(setReportBranding(parsed.data), { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[settings] could not save the report branding: ${message}`);
    return refuse(
      500,
      "Could not save the setting. Check that the data directory is writable.",
    );
  }
}
