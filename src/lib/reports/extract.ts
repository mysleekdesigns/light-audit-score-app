/**
 * Stored-report extractors (ROADMAP Phase D).
 *
 * Pure projections of a stored LHR into the wire contract in
 * `@/lib/reports/types`: the request waterfall (`audits["network-requests"]`)
 * and the load filmstrip (`audits["screenshot-thumbnails"]`). Like
 * `@/lib/lighthouse/parseLhr` — whose narrowing helpers these reuse — they are
 * PURE: no Chrome, no `lighthouse` import, no `node:fs`, no DB. The route that
 * serves them reads the report file; everything below only reshapes it.
 *
 * The governing rule is HONEST DEGRADATION, the same contract `reconstructBatch`
 * keeps for a DB-only run: a report that predates an audit, or whose audit
 * errored, yields `unavailable: true` and empty collections — never a throw and
 * never an invented zero. `unavailable` is therefore load-bearing and distinct
 * from an empty collection: a page can genuinely make zero requests, and the UI
 * must be able to say "no requests" rather than "this report is too old".
 *
 * Tolerance is shape-driven, not label-driven: an audit is read whenever its
 * `details.items` is an array, without asserting `details.type`. Lighthouse has
 * renamed things under us before (`render-blocking-resources` became
 * `render-blocking-insight` in v13), so keying on a label we cannot control
 * would turn a future rename into a silent empty state.
 */

import { asNumber, asString, isRecord, pickString } from "@/lib/lighthouse/parseLhr";
import type { LighthouseResult } from "@/lib/lighthouse/types";
import type {
  FilmstripData,
  FilmstripFrame,
  RunTrace,
  WaterfallData,
  WaterfallRequest,
} from "@/lib/reports/types";

/**
 * Render-blocking audit ids, newest first. Lighthouse 13 renamed the pre-13
 * `render-blocking-resources` to `render-blocking-insight`; both are read and
 * their URLs unioned so a report from either era marks its rows.
 */
const RENDER_BLOCKING_AUDIT_IDS = [
  "render-blocking-insight",
  "render-blocking-resources",
] as const;

// --- LHR access helpers (pure, tolerant) ------------------------------------

/** One audit result, or undefined when `audits` is absent/not a map/lacks the id. */
function getAudit(
  lhr: LighthouseResult,
  id: string,
): Record<string, unknown> | undefined {
  const audits = lhr.audits;
  if (!isRecord(audits)) return undefined;
  const audit = audits[id];
  return isRecord(audit) ? audit : undefined;
}

/**
 * An audit's `details.items` when it is a readable array, else undefined —
 * the single test for "this audit is usable". Returning undefined (rather than
 * `[]`) is what lets callers tell an absent audit from a zero-item one.
 */
function detailItems(
  audit: Record<string, unknown> | undefined,
): unknown[] | undefined {
  if (audit === undefined) return undefined;
  const details = audit.details;
  if (!isRecord(details)) return undefined;
  return Array.isArray(details.items) ? details.items : undefined;
}

/**
 * A byte count or HTTP status, treating a negative value as unknown.
 *
 * `-1` is Chrome's "unknown" sentinel, not a measurement: it comes straight
 * from CDP's `encodedDataLength: -1` (a blob/worker request whose bytes DevTools
 * never saw) and from a request that never got a status. Both occur in this
 * repo's stored reports, and the contract's word for "not recorded" is `null`.
 *
 * Summing the sentinel is the trap worth naming: it yields a total one byte
 * BELOW Lighthouse's own — a wrong number that looks plausible. Excluding it
 * makes `totalTransferSize` reconcile exactly with `resource-summary` and
 * `total-byte-weight` on every stored report that carries them.
 */
function asCount(value: unknown): number | null {
  const count = asNumber(value);
  return count === null || count < 0 ? null : count;
}

/** A URL split for display, plus the origin used for first-party comparison. */
interface UrlParts {
  host: string;
  path: string;
  /** Comparable origin, or null when the URL has none we can reason about. */
  origin: string | null;
}

/**
 * Split a request URL into display parts. Two cases have no hostname and so no
 * meaningful path/host split — a URL that will not parse at all, and the
 * opaque schemes Lighthouse records inline (`data:`, `blob:`, `about:`) — and
 * both fall back to showing the raw URL, per the contract. (Lighthouse already
 * truncates `data:` URLs to ~100 chars, so that fallback stays small.)
 *
 * `origin` is deliberately narrower than `host`: `blob:https://site/…` has an
 * empty hostname but a real, comparable origin, while `data:`/`about:` report
 * the string `"null"` — an opaque origin that must never be *compared* against
 * the page's, or every inline resource would be mismarked third-party.
 */
function splitUrl(url: string): UrlParts {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { host: "", path: url, origin: null };
  }
  const origin =
    parsed.origin === "" || parsed.origin === "null" ? null : parsed.origin;
  if (parsed.hostname === "") return { host: "", path: url, origin };
  return {
    host: parsed.hostname,
    path: `${parsed.pathname}${parsed.search}`,
    origin,
  };
}

/**
 * `entity name -> isFirstParty` from the top-level `lhr.entities` table, or
 * null when the report carries none (pre-entities Lighthouse). Null is not the
 * same as an empty map: it is the signal to fall back to origin comparison.
 */
function firstPartyByEntity(lhr: LighthouseResult): Map<string, boolean> | null {
  if (!Array.isArray(lhr.entities)) return null;
  const byName = new Map<string, boolean>();
  for (const raw of lhr.entities) {
    if (!isRecord(raw)) continue;
    const name = asString(raw.name);
    if (name === undefined || name === "") continue;
    // Only an explicit `true` is first-party; Lighthouse omits the flag entirely
    // on third-party entities rather than writing `false`.
    byName.set(name, raw.isFirstParty === true);
  }
  return byName;
}

/** The audited page's origin, used as the third-party fallback yardstick. */
function pageOrigin(lhr: LighthouseResult): string | null {
  const url = pickString(lhr, "mainDocumentUrl", "finalDisplayedUrl", "finalUrl");
  return url === undefined ? null : splitUrl(url).origin;
}

/**
 * Whether a request belongs to someone other than the audited site.
 *
 * The entity table is authoritative when it names the request's entity — it
 * knows that `stats.g.doubleclick.net` is Google even though the page never
 * says so. Otherwise (no table, or an entity absent from it — 0.8% of requests
 * in this repo's reports carry no `entity` at all) fall back to comparing
 * origins. When neither can decide, return false: an unsupportable "3P" badge
 * is worse than none, so we never guess a mark.
 */
function isThirdParty(
  entity: string,
  url: string,
  entities: Map<string, boolean> | null,
  origin: string | null,
): boolean {
  if (entities !== null && entity !== "") {
    const firstParty = entities.get(entity);
    if (firstParty !== undefined) return !firstParty;
  }
  const requestOrigin = splitUrl(url).origin;
  if (requestOrigin === null || origin === null) return false;
  return requestOrigin !== origin;
}

/** Every URL either render-blocking audit named, matched later by exact string. */
function renderBlockingUrls(lhr: LighthouseResult): Set<string> {
  const urls = new Set<string>();
  for (const id of RENDER_BLOCKING_AUDIT_IDS) {
    for (const raw of detailItems(getAudit(lhr, id)) ?? []) {
      if (!isRecord(raw)) continue;
      const url = asString(raw.url);
      if (url !== undefined && url !== "") urls.add(url);
    }
  }
  return urls;
}

// --- Extractors -------------------------------------------------------------

/**
 * Project `audits["network-requests"]` into the waterfall contract, enriched
 * with the render-blocking and third-party marks.
 *
 * Row `index` is the position in the LHR's own item order and is assigned
 * BEFORE any row is skipped, so a malformed item leaves a gap rather than
 * renumbering everything after it — downstream tables sort by other columns and
 * use `index` as the stable row key. An item with no usable `url` is skipped
 * outright (a waterfall row with no URL identifies nothing); a merely missing
 * *field* degrades to the contract's `null`/`""`.
 */
export function extractWaterfall(lhr: LighthouseResult): WaterfallData {
  const items = detailItems(getAudit(lhr, "network-requests"));
  if (items === undefined) {
    return {
      requests: [],
      totalTransferSize: 0,
      totalResourceSize: 0,
      timelineMs: null,
      thirdPartyCount: 0,
      unavailable: true,
    };
  }

  const entities = firstPartyByEntity(lhr);
  const origin = pageOrigin(lhr);
  const blocking = renderBlockingUrls(lhr);

  const requests: WaterfallRequest[] = [];
  let totalTransferSize = 0;
  let totalResourceSize = 0;
  let timelineMs: number | null = null;
  let thirdPartyCount = 0;

  items.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const url = asString(raw.url);
    if (url === undefined || url === "") return;

    const { host, path } = splitUrl(url);
    const transferSize = asCount(raw.transferSize);
    const resourceSize = asCount(raw.resourceSize);
    const startTime = asNumber(raw.networkRequestTime);
    const endTime = asNumber(raw.networkEndTime);
    const entity = asString(raw.entity) ?? "";
    const thirdParty = isThirdParty(entity, url, entities, origin);

    requests.push({
      index,
      url,
      path,
      host,
      resourceType: asString(raw.resourceType) ?? "",
      mimeType: asString(raw.mimeType) ?? "",
      transferSize,
      resourceSize,
      statusCode: asCount(raw.statusCode),
      protocol: asString(raw.protocol) ?? "",
      priority: asString(raw.priority) ?? "",
      startTime,
      endTime,
      durationMs:
        startTime !== null && endTime !== null ? endTime - startTime : null,
      thirdParty,
      entity,
      renderBlocking: blocking.has(url),
      // Only an explicit `false` means unfinished: Lighthouse writes that flag
      // as an exception, and defaulting an absent one to "unfinished" would put
      // a false warning on every row of a report that never emitted the field.
      finished: raw.finished !== false,
      cache: asString(raw.cache) ?? "",
    });

    if (transferSize !== null) totalTransferSize += transferSize;
    if (resourceSize !== null) totalResourceSize += resourceSize;
    if (endTime !== null && (timelineMs === null || endTime > timelineMs)) {
      timelineMs = endTime;
    }
    if (thirdParty) thirdPartyCount += 1;
  });

  return {
    requests,
    totalTransferSize,
    totalResourceSize,
    timelineMs,
    thirdPartyCount,
    unavailable: false,
  };
}

/**
 * Mark the frame the user first sees the LCP element in: the first frame at or
 * after the LCP timing, or — when LCP lands after the strip ends, which happens
 * on slow pages whose filmstrip is capped — the last frame, so the mark is
 * never silently dropped. No LCP or no frames means no mark.
 */
function markLcpFrame(frames: FilmstripFrame[], lcpMs: number | null): void {
  if (lcpMs === null || frames.length === 0) return;
  const frame =
    frames.find((candidate) => candidate.timingMs >= lcpMs) ??
    frames[frames.length - 1];
  frame.isLcp = true;
}

/**
 * Project `audits["screenshot-thumbnails"]` into the filmstrip contract.
 *
 * `lcpMs` is read from `largest-contentful-paint` INDEPENDENTLY of the
 * thumbnails audit, so a report with a metric but no strip still reports the
 * number it has. A frame missing its timing or its image cannot be represented
 * by the contract (both fields are non-nullable) and is skipped.
 */
export function extractFilmstrip(lhr: LighthouseResult): FilmstripData {
  const lcpAudit = getAudit(lhr, "largest-contentful-paint");
  const lcpMs = lcpAudit === undefined ? null : asNumber(lcpAudit.numericValue);

  const items = detailItems(getAudit(lhr, "screenshot-thumbnails"));
  if (items === undefined) {
    return { frames: [], lcpMs, timelineMs: null, unavailable: true };
  }

  const frames: FilmstripFrame[] = [];
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const timingMs = asNumber(raw.timing);
    const data = asString(raw.data);
    // The frame goes straight into an `<img src>`, so accept only an inline
    // image URI — the one thing that is both renderable and inert there.
    if (timingMs === null || data === undefined || !data.startsWith("data:image/")) {
      continue;
    }
    frames.push({ timingMs, data, isLcp: false });
  }

  markLcpFrame(frames, lcpMs);

  return {
    frames,
    lcpMs,
    // Frames arrive in capture order, so the strip's extent is the last one's.
    timelineMs: frames.length === 0 ? null : frames[frames.length - 1].timingMs,
    unavailable: false,
  };
}

/**
 * Both projections of one stored report — the whole payload of
 * `GET /api/reports/:runId/trace`, so the Trace tab costs a single fetch.
 */
export function extractRunTrace(lhr: LighthouseResult, runId: string): RunTrace {
  return {
    runId,
    finalUrl: pickString(lhr, "finalDisplayedUrl", "finalUrl") ?? "",
    waterfall: extractWaterfall(lhr),
    filmstrip: extractFilmstrip(lhr),
  };
}
