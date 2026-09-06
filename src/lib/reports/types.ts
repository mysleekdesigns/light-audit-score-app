/**
 * Stored-report reader contract (ROADMAP Phase D).
 *
 * Phase D is a RENDERING job, not a measurement one: every run already persists
 * its full LHR to `data/reports/<runId>.json`, and two audits in there —
 * `network-requests` and `screenshot-thumbnails` — have never been read by the
 * app. These types are the compact projection of those two audits that crosses
 * the wire, so the browser never downloads a whole report to draw a waterfall.
 *
 * Why compact matters, concretely: stored reports in this repo average ~690 KB
 * and reach 1.5 MB, while the projection below is ~20 KB of request rows (the
 * filmstrip's inline JPEG frames dominate what is left). The extractors run
 * server-side in `GET /api/reports/:runId/trace`; the client receives only this.
 *
 * Every field is nullable-or-empty rather than optional-and-absent, and every
 * extractor returns a well-formed value for a report that lacks the audit
 * entirely (`unavailable: true`, empty collections). A legacy row whose report
 * predates an audit must render an empty state, never throw — the same honest
 * degradation `reconstructBatch` applies to a DB-only run.
 *
 * SECURITY NOTE for consumers: `WaterfallRequest.url`/`path`/`host`/`entity` are
 * attacker-controlled. They come from the page under audit, which chose its own
 * subresource URLs. Render them as text, never as markup, and route any href
 * through `safeHttpHref` (`@/lib/redactUrl`) — the same discipline ROADMAP Phase
 * C's L1 finding forced on alert lines.
 */

/**
 * One row of the request waterfall — a single network request Lighthouse
 * recorded, flattened from `audits["network-requests"].details.items[]` and
 * enriched with the render-blocking / third-party marks the plan calls for.
 */
export interface WaterfallRequest {
  /** Position in the LHR's own request order — a row's stable identity across sorts. */
  index: number;
  /** Full request URL exactly as Lighthouse recorded it. UNTRUSTED (see module note). */
  url: string;
  /** Path + query for display (`/static/app.js?v=2`); the raw URL when unparseable. */
  path: string;
  /** Hostname (`cdn.example.com`); `""` when the URL will not parse (e.g. `data:`). */
  host: string;
  /** Lighthouse's resource kind (`Document`, `Script`, `Image`, …); `""` when absent. */
  resourceType: string;
  /** MIME type as served (`text/html`); `""` when absent. */
  mimeType: string;
  /** Bytes over the wire; `null` when Lighthouse did not record it. */
  transferSize: number | null;
  /** Decoded bytes; `null` when Lighthouse did not record it. */
  resourceSize: number | null;
  /** HTTP status; `null` when the request never got one. */
  statusCode: number | null;
  /** Negotiated protocol (`h2`, `http/1.1`); `""` when absent. */
  protocol: string;
  /** Chrome's fetch priority (`VeryHigh`…`Low`); `""` when absent. */
  priority: string;
  /** ms from navigation start to request start; `null` when absent. */
  startTime: number | null;
  /** ms from navigation start to response end; `null` when absent. */
  endTime: number | null;
  /** `endTime − startTime`; `null` when either end is missing. */
  durationMs: number | null;
  /** True when the request's entity is one Lighthouse does NOT mark first-party. */
  thirdParty: boolean;
  /** Entity name from `lhr.entities` (`Google Analytics`); `""` when unknown. */
  entity: string;
  /** True when a render-blocking audit named this URL. */
  renderBlocking: boolean;
  /** Whether the request completed (an unfinished request has no meaningful end). */
  finished: boolean;
  /** Cache state Lighthouse recorded (`none`, `disk`, `memory`); `""` when absent. */
  cache: string;
}

/** The waterfall projection of one stored report. */
export interface WaterfallData {
  /** Requests in the LHR's own order. Empty when the audit is absent. */
  requests: WaterfallRequest[];
  /** Sum of every non-null `transferSize`, in bytes. */
  totalTransferSize: number;
  /** Sum of every non-null `resourceSize`, in bytes. */
  totalResourceSize: number;
  /** Largest `endTime` seen — the time axis extent, in ms. `null` when unknown. */
  timelineMs: number | null;
  /** How many requests carry `thirdParty: true`. */
  thirdPartyCount: number;
  /**
   * True when the source report carried no usable `network-requests` audit —
   * the signal for an "this report predates the feature" empty state, which is
   * NOT the same as a page that genuinely made zero requests.
   */
  unavailable: boolean;
}

/** One filmstrip thumbnail: a screenshot Lighthouse captured mid-load. */
export interface FilmstripFrame {
  /** ms from navigation start. */
  timingMs: number;
  /** A `data:image/jpeg;base64,…` URI — inline, so the strip makes no requests. */
  data: string;
  /** True for the single frame that first lands at or after the LCP timing. */
  isLcp: boolean;
}

/** The filmstrip projection of one stored report. */
export interface FilmstripData {
  /** Frames in capture order. Empty when the audit is absent. */
  frames: FilmstripFrame[];
  /** LCP in ms from the `largest-contentful-paint` audit; `null` when absent. */
  lcpMs: number | null;
  /** The last frame's timing — the strip's extent, in ms. `null` when no frames. */
  timelineMs: number | null;
  /** True when the source report carried no usable `screenshot-thumbnails` audit. */
  unavailable: boolean;
}

/**
 * The whole payload of `GET /api/reports/:runId/trace` — both projections of one
 * stored report, read once so the detail sheet's Trace tab costs a single fetch.
 */
export interface RunTrace {
  /** Echo of the requested run id. */
  runId: string;
  /** `finalDisplayedUrl`/`finalUrl` from the LHR; `""` when absent. UNTRUSTED. */
  finalUrl: string;
  waterfall: WaterfallData;
  filmstrip: FilmstripData;
}
