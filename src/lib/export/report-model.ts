/**
 * The client-ready report contract (ROADMAP Phase H).
 *
 * Phase H turns a finished batch into ONE self-contained HTML file an auditor
 * can hand to a client: a summary, a page-by-page breakdown with scores, Core
 * Web Vitals and top opportunities, and — from Phase D's stored-report readers —
 * a request waterfall and a loading filmstrip. It renders offline and prints to
 * a legible PDF, with no PDF library and no headless-render step.
 *
 * This module is the seam between the two halves of that job:
 *
 *  - **assembly** (`./report-data.ts`, Node-only) reads SQLite + the stored LHRs
 *    and produces a {@link ClientReport};
 *  - **rendering** (`./report-html.ts`, pure) turns a {@link ClientReport} into
 *    the HTML document, and knows nothing about disks or databases.
 *
 * Splitting them is what makes the renderer unit-testable from a literal fixture
 * and keeps `node:fs` out of anything a client component could import — the same
 * discipline `exporters.ts` (pure) / `download.ts` (DOM) already follow here, and
 * `@/lib/reports/types` follows for Phase D's projections.
 *
 * **Every field is a display value.** By the time a {@link ClientReport} exists,
 * numbers are formatted, text is truncated, and untrusted strings have been
 * flattened with `@/lib/text/displaySafe`. The renderer's only remaining job on
 * the safety side is HTML-escaping — which it does unconditionally, because a
 * lot of what is in here was written by the audited page.
 *
 * SECURITY NOTE, the same one `@/lib/reports/types` carries and for the same
 * reason: `ReportPage.url`, `finalUrl`, `errorMessage`, every
 * {@link ReportRequest} string, and an opportunity's `displayValue` are
 * ATTACKER-CONTROLLED — the audited site chose its own URLs, and a failing
 * request's message can quote them. The exported file is a document the user
 * opens locally and emails onward, so the rule is stricter here than on screen:
 * render them as text, never as markup, and never emit an href for one. The
 * document ships no script at all and declares a locked-down CSP in a `<meta>`,
 * so even a hypothetical escaping miss has nothing to execute.
 *
 * PRIVACY NOTE, which is a different problem from the one above and was the
 * finding of Phase H's security review. This document is BUILT TO BE SENT to
 * someone who is not the person who ran the audit, and it carries two things
 * that deserve a second look before it is: the audited pages' request URLs
 * (`ReportRequest.path` is "path + query", and in this repo's own archive 43% of
 * requests carry a query string, some with visitor and session identifiers), and
 * real screenshots of the pages (`ReportFrame.data`, ~250×500, legible enough for
 * headings and a signed-in user's name). Assembly redacts credential-,
 * signature- and session-shaped query VALUES via `redactForExport`, and strips
 * `user:pass@` — but parameter names are unbounded, so that is a net and not a
 * guarantee. A report of an authenticated, staging or internal target is a
 * disclosure decision, and the product says so where the user can see it rather
 * than only here.
 */

import type { BatchStatus } from "@/lib/queue/types";
import type {
  AuditSource,
  CategoryScores,
  FormFactor,
  LighthouseCategory,
  MetricId,
} from "@/lib/lighthouse/types";
import type { CategoryThresholds } from "@/lib/settings/defaults";

/** Contract version, stamped into every report so a stale file identifies itself. */
export const CLIENT_REPORT_VERSION = 1 as const;

/**
 * Caps applied during assembly, declared here so the renderer can be honest
 * about what was left out rather than silently drawing a partial picture.
 *
 * They exist because a report is a FILE, not a page: a 30-page batch with an
 * uncapped waterfall and every filmstrip frame is tens of megabytes of inline
 * data URIs, which is not something anyone emails a client.
 *
 * **What they actually cost, measured rather than estimated.** Over 60 of this
 * repo's own stored reports, the 8 sampled filmstrip frames come to a median of
 * **209 KB per page** (min 14 KB, max 440 KB) — the frames dominate; the capped
 * waterfall and the rest of the page are a few KB beside them. So:
 *
 *  - a typical 18-page batch exports at about **5 MB** (measured: 5.29 MB);
 *  - a batch at the 60-page cap lands nearer **12 MB**, and up to **26 MB** for
 *    image-heavy pages.
 *
 * An earlier version of this comment claimed the caps keep a report "comfortably
 * under a few MB", which is true of a small batch and off by 4–10× at the page
 * cap. Phase H's security review caught it. The numbers above are the honest
 * ones, and they are a real trade rather than a defect: inlining the frames is
 * exactly what makes the file render with the network disabled, which is the
 * feature. If a smaller file ever matters more than the filmstrip does,
 * `frames` is the dial to turn — it is where the bytes are.
 */
export const REPORT_CAPS = {
  /** Opportunities per page — "top opportunities", biggest estimated saving first. */
  opportunities: 5,
  /** Waterfall rows per page, kept in Lighthouse's own request order. */
  requests: 40,
  /** Filmstrip frames per page, evenly sampled across the strip's full extent. */
  frames: 8,
  /** Pages per report. A batch larger than this exports its first N pages. */
  pages: 60,
} as const;

/**
 * The optional title / logo / date block at the top of the report, filled from
 * the user's own non-secret local settings (`app_settings`).
 *
 * `logoDataUri` is a `data:` URI and nothing else — never an `http(s)` URL. That
 * is not a stylistic preference: the report must render with the network
 * disabled, so a remote logo would be a broken image in the one place a client
 * looks first, and it would also phone home from the recipient's machine every
 * time the file is opened. Assembly is what enforces the scheme; the renderer
 * enforces it again rather than trusting its input.
 */
export interface ReportBranding {
  /** Auditor / agency name for the header. `""` when unset (block is omitted). */
  title: string;
  /** One-line strapline under the title. `""` when unset. */
  subtitle: string;
  /** A `data:image/…;base64,…` URI, or `""` when no logo is configured. */
  logoDataUri: string;
  /** Whether to print the generated-on date. */
  showDate: boolean;
}

/**
 * The limits the branding fields are held to, in the one place both sides can
 * read them.
 *
 * They live HERE rather than beside the store in `@/lib/settings/branding`
 * because two parties need them and only one of those can reach a database: the
 * store enforces them server-side, and the Settings panel needs the same numbers
 * to refuse a file and to label its inputs before a round-trip. Importing them
 * from the store would pull `better-sqlite3` into the browser bundle, so the
 * panel had copied all three as local constants — three numbers with no link
 * between the copies, which is precisely the drift the contract module exists to
 * prevent.
 *
 * `logoMaxBytes` is measured on the DECODED image, not on the base64 text, and
 * the store computes that arithmetically rather than decoding — the point of a
 * cap is to refuse an oversized payload, not to materialise it first.
 *
 * SVG is absent from `logoMimeTypes` deliberately, and it is the one exclusion
 * worth explaining. An `<img src="data:image/svg+xml,…">` is script-disabled by
 * spec, and this document grants no `script-src` at all, so an SVG logo would
 * very probably be harmless. "Very probably" is the problem: the exported file
 * leaves the machine that made it and is opened by someone else, in a viewer we
 * will never see, possibly years later. A raster logo costs the user one export
 * from their design tool and removes the question.
 */
export const BRANDING_LIMITS = {
  /** Max characters in the header title. */
  titleMax: 80,
  /** Max characters in the strapline. */
  subtitleMax: 160,
  /** Max DECODED bytes of the logo image (256 KB). */
  logoMaxBytes: 256 * 1024,
  /** The raster `data:image/<subtype>` forms a logo may take. */
  logoMimeTypes: ["png", "jpeg", "webp", "gif"],
} as const;

/** Branding as it reads before the user configures anything: no header block. */
export const EMPTY_BRANDING: ReportBranding = {
  title: "",
  subtitle: "",
  logoDataUri: "",
  showDate: true,
};

/** One Core Web Vital / key timing on a page, pre-formatted for display. */
export interface ReportMetric {
  id: MetricId;
  /** Short form for the dense grid (`LCP`). */
  abbr: string;
  /** Full name for the print rendering (`Largest Contentful Paint`). */
  label: string;
  /** Lighthouse's own formatted value (`1.2 s`); {@link ABSENT_VALUE} when missing. */
  displayValue: string;
  /** Raw milliseconds (or unitless, for CLS); `null` when the run has no value. */
  numericValue: number | null;
  /** 0–1 audit score, or `null` when unscored — drives the metric's colour band. */
  score: number | null;
}

/** One performance opportunity, biggest estimated saving first. */
export interface ReportOpportunity {
  /** Lighthouse audit id (`unused-javascript`) — stable, ours, safe as a key. */
  id: string;
  /** Lighthouse's own title. Not page-authored, but escaped like everything else. */
  title: string;
  /** One-sentence description, truncated during assembly. */
  description: string;
  /** Estimated wall-clock saving in ms; `null` when Lighthouse gave none. */
  savingsMs: number | null;
  /** Lighthouse's summary (`Est savings of 0.45 s`). UNTRUSTED — page-derived. */
  displayValue: string;
  /** 0–1 audit score, or `null`. */
  score: number | null;
}

/**
 * One waterfall row, narrowed from Phase D's `WaterfallRequest` to what a
 * printed page can actually carry. The full projection has eighteen fields; a
 * client report shows six and a bar.
 */
export interface ReportRequest {
  /** Path + query for display. UNTRUSTED. */
  path: string;
  /** Hostname. `""` when the URL will not parse. UNTRUSTED. */
  host: string;
  /** Lighthouse's resource kind (`Script`, `Image`); `""` when absent. */
  resourceType: string;
  /** Bytes over the wire; `null` when unrecorded. */
  transferSize: number | null;
  /** ms from navigation start to request start; `null` when absent. */
  startTime: number | null;
  /** ms from navigation start to response end; `null` when absent. */
  endTime: number | null;
  /** True when a render-blocking audit named this URL. */
  renderBlocking: boolean;
  /** True when Lighthouse did not mark the request's entity first-party. */
  thirdParty: boolean;
}

/** A page's request waterfall, already capped and summarised. */
export interface ReportWaterfall {
  /** Up to {@link REPORT_CAPS.requests} rows, in Lighthouse's own order. */
  requests: ReportRequest[];
  /** How many requests the page actually made, before the cap. */
  totalRequests: number;
  /** Sum of every non-null `transferSize` across ALL requests, in bytes. */
  totalTransferSize: number;
  /** How many of ALL requests were third-party. */
  thirdPartyCount: number;
  /** The time axis extent in ms — bars are drawn against this. `null` when unknown. */
  timelineMs: number | null;
}

/** One filmstrip thumbnail, inline so the strip makes no network requests. */
export interface ReportFrame {
  /** ms from navigation start. */
  timingMs: number;
  /** A `data:image/jpeg;base64,…` URI. */
  data: string;
  /** True for the frame at or after the LCP timing. */
  isLcp: boolean;
}

/** A page's loading filmstrip, already sampled down to {@link REPORT_CAPS.frames}. */
export interface ReportFilmstrip {
  frames: ReportFrame[];
  /** LCP in ms; `null` when the report carried no LCP audit. */
  lcpMs: number | null;
  /** The last frame's timing — the strip's extent in ms. `null` when no frames. */
  timelineMs: number | null;
}

/**
 * Why a page carries no trace, so the document can say which — "this run predates
 * the feature" and "we could not read the file" are different sentences, and a
 * client-facing report that blurs them invites the wrong question.
 */
export type TraceOmission =
  /** The run errored, or never stored a report to read. */
  | "no-report"
  /** The report exists but carried neither audit (a pre-Phase-D or PSI run). */
  | "unavailable"
  /** The file was present and could not be read or parsed. */
  | "unreadable";

/** One audited page in the report. */
export interface ReportPage {
  /** Run id — the anchor target the summary table links to within the document. */
  runId: string;
  /** The URL the user asked for. UNTRUSTED. */
  url: string;
  /** Where the audit actually landed; `""` when unknown or identical. UNTRUSTED. */
  finalUrl: string;
  device: FormFactor;
  /** Which engine produced the run — a PSI page has no waterfall to show. */
  source: AuditSource;
  status: "done" | "error";
  /** The failure, flattened to one line; `null` for a successful run. UNTRUSTED. */
  errorMessage: string | null;
  /** How many runs the median was taken over; `null` for a failure. */
  runs: number | null;
  /** ISO fetch time of the median run; `null` for a failure. */
  fetchTime: string | null;
  /** Median category scores, 0–100. The same numbers the app shows. */
  scores: CategoryScores;
  /** Mean of the present category scores; `null` when nothing scored. */
  overall: number | null;
  /** True when every category this page scored met its threshold. */
  clears: boolean;
  metrics: ReportMetric[];
  opportunities: ReportOpportunity[];
  /** `null` when there is no trace to show — see {@link traceOmission}. */
  waterfall: ReportWaterfall | null;
  /** `null` when there is no trace to show — see {@link traceOmission}. */
  filmstrip: ReportFilmstrip | null;
  /** Set exactly when BOTH `waterfall` and `filmstrip` are `null`. */
  traceOmission: TraceOmission | null;
}

/** The best- or worst-scoring page, reduced to what the summary prints. */
export interface ReportHighlight {
  runId: string;
  /** UNTRUSTED. */
  url: string;
  overall: number | null;
}

/** The batch-level readout at the top of the report. */
export interface ReportSummary {
  /** Mean score per category over the done runs — the Batch Summary's own numbers. */
  averageScores: CategoryScores;
  /** Mean of the present category averages; `null` when nothing scored. */
  overall: number | null;
  /** Per-category pass counts against the user's thresholds. */
  passFail: Record<LighthouseCategory, { pass: number; fail: number; total: number }>;
  /** How many measured pages cleared every one of their thresholds. */
  clearing: { clearing: number; total: number };
  best: ReportHighlight | null;
  worst: ReportHighlight | null;
  /** Pages in the report (after {@link REPORT_CAPS.pages}). */
  pageCount: number;
  /** How many of those failed outright. */
  errorCount: number;
}

/** How the batch was run, printed as the report's provenance line. */
export interface ReportProvenance {
  /** `local` or `psi`. */
  source: AuditSource;
  /** Device(s) the batch used, as a display string (`Mobile`, `Mobile + Desktop`). */
  device: string;
  /** Throttling method, as a display string. */
  throttling: string;
  /** Median-of-N. */
  runs: number;
  /** Lighthouse version that produced the runs; `""` when no run recorded one. */
  lighthouseVersion: string;
  /** ISO timestamp the batch was created. */
  createdAt: string;
  /**
   * The batch's lifecycle state, printed so the document cannot pass a partial
   * audit off as a finished one.
   *
   * This is not bookkeeping. A 20-URL batch cancelled after 5 pages otherwise
   * exports as "Batch summary — 5 pages" with pass/fail over those five and no
   * hint that fifteen were never run, and the client reads it as a complete
   * survey of their site. Phase H's security review found exactly that, and it is
   * this module's own stated principle — a report that draws a subset "is making
   * a claim about the site that is not true" — applied to requests but not, until
   * now, to the batch itself.
   */
  status: BatchStatus;
  /**
   * Jobs the batch was created with, so {@link ReportSummary.pageCount} can be
   * compared against what was INTENDED rather than against what happened to
   * persist.
   *
   * Counts JOBS, not URLs: a `"both"` batch fans each URL into a mobile and a
   * desktop job, so twelve pages from six URLs is complete, not half-finished.
   * Compare it with the number of runs, never with a URL count.
   */
  total: number;
}

/**
 * Everything the exported document renders. Self-contained by construction: no
 * field is a URL the renderer must fetch, and every image is already a `data:`
 * URI.
 */
export interface ClientReport {
  version: typeof CLIENT_REPORT_VERSION;
  /** Full batch id. */
  batchId: string;
  /** The 8-char form the UI shows, so the file and the app agree. */
  shortId: string;
  /** ISO timestamp the export was generated. */
  generatedAt: string;
  branding: ReportBranding;
  provenance: ReportProvenance;
  /** The per-category bars the pass/fail tallies were judged against. */
  thresholds: CategoryThresholds;
  summary: ReportSummary;
  pages: ReportPage[];
  /**
   * Plain-English notes about anything the caps left out ("Showing 40 of 312
   * requests"), so the document never overstates itself. Ours, not page-derived.
   */
  notes: string[];
}

/** The em dash the whole app uses for a value that isn't there. */
export const ABSENT_VALUE = "—";

/**
 * The filename an exported report is offered under — batch-scoped and
 * timestamped, matching the JSON/CSV exports' `lighthouse-batch-<id>-<stamp>`
 * shape so the three sort together in a downloads folder.
 */
export function reportFileName(shortId: string, stamp: string): string {
  // `shortId` is a nanoid slice from our own database and `stamp` is ours, so
  // neither is caller-supplied — and this string lands in a `Content-Disposition`
  // header, where a quote or a newline would be a header-injection primitive
  // rather than a cosmetic problem. `safeAnchorId` in the renderer already
  // refuses to trust an id from the same database on the grounds that "ours" is
  // not something a function can verify at runtime; this is the same reasoning
  // applied to the one value that leaves the process as a header. (Phase H
  // review noted the two disagreed.)
  const safe = /^[A-Za-z0-9_-]+$/.test(shortId) ? shortId : "batch";
  const safeStamp = /^[0-9T:-]+$/.test(stamp) ? stamp : "export";
  return `lighthouse-report-${safe}-${safeStamp}.html`;
}

/* -------------------------------------------------------------------------- */
/* Logo validation — one function, four callers                               */
/* -------------------------------------------------------------------------- */

/**
 * The whole accepted logo shape, anchored end to end.
 *
 * Anchored because a substring match is not a scheme check: `javascript:…` with
 * a `data:image/png;base64,` needle somewhere inside it would pass an unanchored
 * test. Case-insensitive because RFC 2397 makes the scheme and media type
 * case-insensitive and a hand-written value may well be `DATA:IMAGE/PNG` — what
 * is stored is normalised to lower case below, so the strict lower-case checks
 * downstream (assembly, then the renderer) see exactly what they expect.
 *
 * The payload is matched separately, and strictly: no whitespace, no line
 * breaks, no URL-safe alphabet. `FileReader.readAsDataURL` never emits any of
 * those, so accepting them would only widen the surface for a hand-crafted
 * value with nothing legitimate to gain.
 */
const LOGO_DATA_URI = new RegExp(
  `^data:image/(${BRANDING_LIMITS.logoMimeTypes.join("|")});base64,([A-Za-z0-9+/]+={0,2})$`,
  "i",
);

/** Canonical base64: a multiple of four, padded only at the very end. */
const BASE64_BODY = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decoded byte length of a canonical base64 body, computed arithmetically
 * rather than by decoding it.
 *
 * Decoding to measure would mean materialising the very payload the cap exists
 * to refuse, and `Buffer` is lenient about exactly the malformed input this
 * function is asked about. Four base64 characters carry three bytes; each `=`
 * takes one of them back.
 */
function base64ByteLength(body: string): number {
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return (body.length / 4) * 3 - padding;
}

/**
 * Validate a would-be logo, returning the canonical `data:` URI to store or
 * `""` when it is anything else at all.
 *
 * Rejection is always total: a value that fails any check becomes `""` rather
 * than a truncated or repaired one. Half a logo is a broken image in a client's
 * inbox, which is worse than no logo — and "repair it" is how an allow-list
 * quietly turns into a parser.
 */
export function sanitizeLogoDataUri(value: unknown): string {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  if (!candidate) return "";
  // Cheap length gate first: base64 is 4 characters per 3 bytes, so anything
  // longer than the cap allows cannot pass, and there is no point running a
  // regex over a megabyte to find that out.
  if (candidate.length > Math.ceil((BRANDING_LIMITS.logoMaxBytes / 3) * 4) + 64) return "";

  const match = LOGO_DATA_URI.exec(candidate);
  if (!match) return "";

  const [, mime, body] = match;
  if (!BASE64_BODY.test(body)) return "";
  if (base64ByteLength(body) > BRANDING_LIMITS.logoMaxBytes) return "";

  // Normalise the prefix, keep the payload byte-for-byte: base64 is
  // case-SENSITIVE, so lower-casing the whole string would corrupt the image.
  return `data:image/${mime.toLowerCase()};base64,${body}`;
}

