"use client";

/**
 * "Crawl site" tab body for the New Audit form (PRD §6 Phase 5).
 *
 * This panel is the discovery *controls* form: a seed URL + crawl knobs (depth,
 * max pages, sources, exclude paths) and a Discover action that runs sitemap
 * parse + shallow BFS crawl server-side through {@link discoverSite}. It also
 * renders the compact discovery diagnostics (found / cap / robots-blocked /
 * warnings) right next to the controls that produced them.
 *
 * Composition seam: discovery RESULT + selection state are lifted up to
 * `NewAuditForm` so the curation list can render full-width in the workspace
 * below the input card (not cramped in this 50% column). This panel just reports
 * each fresh result up via {@link CrawlPanelProps.onDiscover}; the parent owns
 * the selection and feeds the resolved set into the same `CreateBatchRequest`
 * the paste tab uses, so discovered URLs flow through the existing batch queue
 * with zero new contract.
 */

import { useCallback, useId, useState } from "react";
import { toast } from "sonner";
import {
  CircleSlash,
  Filter,
  Info,
  ListTree,
  Network,
  Search,
  TriangleAlert,
} from "lucide-react";

import { discoverSite } from "@/lib/client/crawlClient";
import {
  clampPages,
  DEFAULT_DEPTH,
  DEFAULT_PAGES,
  DEFAULT_USE_CRAWL,
  DEFAULT_USE_SITEMAP,
  MAX_DEPTH,
  MAX_EXCLUDE_PATHS,
  MAX_PAGES,
  MIN_DEPTH,
  MIN_PAGES,
  type DiscoverResult,
} from "@/lib/crawl/types";
import {
  PAGES_PER_TEMPLATE_ALL,
  PAGES_PER_TEMPLATE_OPTIONS,
} from "@/lib/crawl/template";
import { ApiError } from "@/lib/client/auditClient";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Readout,
  ReadoutCell,
  ReadoutCells,
  ReadoutNote,
} from "@/components/audit/readout";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";

/** Range helper: inclusive integer list `from..to` (mirrors new-audit-form). */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const DEPTH_OPTIONS = range(MIN_DEPTH, MAX_DEPTH);

/**
 * Sentinel `<Select>` value for "no per-template sampling" — maps to
 * {@link PAGES_PER_TEMPLATE_ALL} (0) on the way out. Select values must be
 * non-empty strings, so the All option carries this rather than "0".
 */
const PPT_ALL_VALUE = "all";

/**
 * Parse the exclude-paths textarea into a clean `string[]`: patterns split on
 * newlines and/or commas, trimmed, blank entries dropped. Lets the user list
 * several patterns on one line (`/admin/*, /drafts`) or one per line — or mix
 * both. The route's zod schema is the validation authority (rejects
 * empties/over-long/too-many) — this just shapes the input.
 */
function parseExcludePaths(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Normalize a raw seed into an absolute http/https URL string.
 *
 * The server only accepts absolute http/https URLs, so a bare `example.com`
 * becomes `https://example.com`. We do not otherwise validate here — the route's
 * zod schema is the authority; we just give it the best-shaped input we can.
 */
function normalizeSeed(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export interface CrawlPanelProps {
  /**
   * Reports a fresh discovery result up to the parent, which owns the selection
   * and renders the curation list full-width in the workspace below. Fires once
   * per successful discovery.
   */
  onDiscover: (result: DiscoverResult) => void;
  /**
   * The latest discovery result (owned by the parent), used here only to render
   * the compact in-tab diagnostics summary. Null until the first discovery.
   */
  result: DiscoverResult | null;
  /**
   * Per-template sampling cap (owned by the parent so it persists + drives the
   * selection). `0` = {@link PAGES_PER_TEMPLATE_ALL} = keep every discovered URL.
   */
  pagesPerTemplate: number;
  /** Sets the sampling cap; the parent re-samples the selection live. */
  onPagesPerTemplateChange: (n: number) => void;
  /** Locks inputs while a batch from this form is running. */
  disabled?: boolean;
}

export function CrawlPanel({
  onDiscover,
  result,
  pagesPerTemplate,
  onPagesPerTemplateChange,
  disabled = false,
}: CrawlPanelProps) {
  const seedId = useId();
  const depthId = useId();
  const pagesId = useId();
  const templateId = useId();
  const scopeId = useId();
  const excludeId = useId();

  const [seed, setSeed] = useState("");
  const [depth, setDepth] = useState(DEFAULT_DEPTH);
  const [maxPages, setMaxPages] = useState(DEFAULT_PAGES);
  // Raw textarea text; parsed into a clean string[] only when discovering.
  const [excludeText, setExcludeText] = useState("");
  // Discovery scope toggles, both on by default. Stored as a string[] for the
  // multiple-ToggleGroup; resolved to the two booleans the request needs.
  const [scope, setScope] = useState<string[]>(
    [
      DEFAULT_USE_SITEMAP ? "sitemap" : null,
      DEFAULT_USE_CRAWL ? "crawl" : null,
    ].filter((v): v is string => v !== null),
  );

  const [isDiscovering, setIsDiscovering] = useState(false);

  const useSitemap = scope.includes("sitemap");
  const useCrawl = scope.includes("crawl");
  // True once the user has typed a seed — flips Discover to the cyan primary
  // variant (mirroring the Run audit button) to signal it's ready to fire.
  const hasSeed = seed.trim().length > 0;

  // The discovered set may exceed the cap; flag it so the summary can say so.
  const truncated = result != null && result.totalFound > result.urls.length;

  function handleScopeChange(value: string[]) {
    // Require at least one discovery method — refuse the empty deselect.
    if (value.length === 0) return;
    setScope(value);
  }

  const handleDiscover = useCallback(async () => {
    const url = normalizeSeed(seed);
    if (!url) {
      toast.error("Enter a domain or seed URL to crawl.");
      return;
    }
    setIsDiscovering(true);
    try {
      const res = await discoverSite({
        url,
        useSitemap,
        useCrawl,
        maxDepth: depth,
        maxPages,
        excludePaths: parseExcludePaths(excludeText),
      });
      // Hand the result up — the parent stores it, selects everything by default,
      // and renders the curation list full-width in the workspace below.
      onDiscover(res);
      if (res.urls.length === 0) {
        toast.warning("No URLs discovered for that origin.");
      }
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.issues[0]?.message ?? err.message
          : "Discovery failed. Is the dev server running?";
      toast.error(message);
    } finally {
      setIsDiscovering(false);
    }
  }, [seed, useSitemap, useCrawl, depth, maxPages, excludeText, onDiscover]);

  return (
    // Own container so every band below measures *this* panel, which is half the
    // card at ≥1440px and all of it below. Bands mirror Run config: a hero input,
    // an aligned dial row, a full-width list field, then an instrument readout.
    <div className="@container flex flex-col gap-5">
      {/* Band 1 — the seed. This is the one thing the tab exists to collect, so
          it gets its own bezel instead of sitting at the same weight as the
          knobs that merely bound it. */}
      <Readout className="gap-2.5">
        <Field>
          <FieldLabel htmlFor={seedId} className="text-foreground">
            Domain or seed URL
          </FieldLabel>
          {/* Mobile-first: the trigger drops below the field on a phone-width
              column rather than squeezing the URL input into a sliver. */}
          <div className="flex flex-col gap-2 @xs:flex-row @xs:items-center">
            <Input
              id={seedId}
              value={seed}
              onChange={(event) => setSeed(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isDiscovering && !disabled) {
                  event.preventDefault();
                  void handleDiscover();
                }
              }}
              disabled={disabled || isDiscovering}
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              className="font-mono text-sm"
              placeholder="example.com"
            />
            <Button
              type="button"
              variant={hasSeed ? "default" : "secondary"}
              onClick={() => void handleDiscover()}
              disabled={disabled || isDiscovering || !hasSeed}
              className="@xs:shrink-0"
            >
              {isDiscovering ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Discovering…
                </>
              ) : (
                <>
                  <Search data-icon="inline-start" />
                  Discover
                </>
              )}
            </Button>
          </div>
        </Field>
        <ReadoutNote>
          No scheme? https:// is assumed. Discovery never leaves the origin.
        </ReadoutNote>
      </Readout>

      {/* Band 2 — the four knobs that bound a crawl, on one baseline. Four
          divides evenly at every tier (1 / 2 / 4), so the row never leaves the
          orphan cell the old 3-up-plus-a-pair layout did. Per-field help moved
          to the single caption below so the controls stay aligned. */}
      <div className="grid grid-cols-1 gap-x-5 gap-y-4 @sm:grid-cols-2 @3xl:grid-cols-4">
        <Field>
          <FieldLabel htmlFor={depthId}>Crawl depth</FieldLabel>
          <Select
            value={String(depth)}
            onValueChange={(value) => setDepth(Number(value))}
            disabled={disabled || isDiscovering || !useCrawl}
          >
            <SelectTrigger id={depthId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {DEPTH_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    Depth {n}
                    {n === 0 ? " (seed only)" : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor={pagesId}>Max pages</FieldLabel>
          <Input
            id={pagesId}
            type="number"
            inputMode="numeric"
            min={MIN_PAGES}
            max={MAX_PAGES}
            step={1}
            value={maxPages}
            onChange={(event) => {
              // Track the typed value live; clamp on blur so typing isn't
              // fought mid-keystroke. Empty/NaN falls back to the default.
              const next = event.target.valueAsNumber;
              setMaxPages(Number.isNaN(next) ? DEFAULT_PAGES : next);
            }}
            onBlur={() => setMaxPages((n) => clampPages(n))}
            disabled={disabled || isDiscovering}
            title={`Hard cap on discovered URLs (${MIN_PAGES}–${MAX_PAGES}).`}
            className="font-mono text-sm tabular-nums"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor={templateId}>Pages / template</FieldLabel>
          <Select
            value={
              pagesPerTemplate > 0 ? String(pagesPerTemplate) : PPT_ALL_VALUE
            }
            onValueChange={(value) =>
              onPagesPerTemplateChange(
                value === PPT_ALL_VALUE ? PAGES_PER_TEMPLATE_ALL : Number(value),
              )
            }
            disabled={disabled || isDiscovering}
          >
            <SelectTrigger
              id={templateId}
              className="w-full"
              title="Sample at most N representative pages per URL template (e.g. /products/*) from the discovered set — keeps big crawls fast and (for PageSpeed) within quota."
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={PPT_ALL_VALUE}>All pages</SelectItem>
                {PAGES_PER_TEMPLATE_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} per template
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor={scopeId}>Discovery sources</FieldLabel>
          <ToggleGroup
            id={scopeId}
            type="multiple"
            variant="outline"
            spacing={0}
            // A <label> can't name a role=group div — name the group itself.
            aria-label="Discovery sources"
            value={scope}
            onValueChange={handleScopeChange}
            disabled={disabled || isDiscovering}
            title="At least one source stays enabled."
            className="w-full"
          >
            <ToggleGroupItem value="sitemap" className="flex-1">
              <Network data-icon="inline-start" />
              Parse sitemap
            </ToggleGroupItem>
            <ToggleGroupItem value="crawl" className="flex-1">
              <Search data-icon="inline-start" />
              Crawl links
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
      </div>

      {/* One caption for the whole row, so four controls keep a single baseline
          instead of four ragged help paragraphs — and it can say the thing no
          individual label can: that depth is inert without link crawling. */}
      <FieldDescription className="-mt-1">
        {useCrawl
          ? `Depth bounds how far links are followed from the seed. Max pages caps the result (${MIN_PAGES}–${MAX_PAGES}); pages / template then samples N per URL pattern.`
          : `“Crawl links” is off — only the sitemap is read, so depth does not apply. Max pages still caps the result (${MIN_PAGES}–${MAX_PAGES}).`}
      </FieldDescription>

      {/* Band 3 — the exclude list. Full width: it is free text that benefits
          from every column the panel has, and it has no partner to pair with. */}
      <Field>
        <FieldLabel htmlFor={excludeId}>Exclude paths</FieldLabel>
        <Textarea
          id={excludeId}
          value={excludeText}
          onChange={(event) => setExcludeText(event.target.value)}
          disabled={disabled || isDiscovering}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          rows={2}
          className="font-mono text-xs"
          placeholder={"/admin/*, /drafts, *.pdf"}
        />
        <FieldDescription>
          One per line or comma-separated · prefix (
          <span className="font-mono">/blog</span>) or glob (
          <span className="font-mono">/admin/*</span>) · up to{" "}
          {MAX_EXCLUDE_PATHS}
        </FieldDescription>
      </Field>

      {/* Discovery summary + notices */}
      {result ? (
        <>
          <Separator />

          {result.robotsBlocked ? (
            <Alert variant="destructive">
              <CircleSlash />
              <AlertTitle>Blocked by robots.txt</AlertTitle>
              <AlertDescription>
                The origin&rsquo;s robots.txt disallowed crawling the seed.
                Sitemap results (if any) are shown below.
              </AlertDescription>
            </Alert>
          ) : null}

          {result.warnings.length > 0 ? (
            <Alert>
              <TriangleAlert className="text-score-average" />
              <AlertTitle>Discovery notes</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-0.5 pl-4">
                  {result.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {/* Band 4 — the discovery readout. Deliberately the same bezel and
              cell grammar as Run config's calibration strip, so both halves of
              the card land on a matching instrument face. The curation list and
              selection count live full-width in the workspace panel below. */}
          <Readout>
            <ReadoutCells>
              <ReadoutCell
                icon={<ListTree className="size-3" aria-hidden />}
                label="Discovered"
                value={String(result.urls.length)}
                tone={result.urls.length > 0 ? "good" : "warn"}
              />
              <ReadoutCell
                icon={<Filter className="size-3" aria-hidden />}
                label="Found"
                value={String(result.totalFound)}
                tone={truncated ? "warn" : "default"}
              />
              <ReadoutCell
                icon={<Info className="size-3" aria-hidden />}
                label="Notes"
                value={
                  result.warnings.length > 0
                    ? String(result.warnings.length)
                    : "—"
                }
                tone={result.warnings.length > 0 ? "warn" : "default"}
              />
            </ReadoutCells>
            <ReadoutNote>
              {result.urls.length > 0
                ? `Same-origin scan of ${result.origin}${truncated ? ` — capped at ${result.urls.length} of ${result.totalFound}` : ""}. Curate & run from the panel below ↓`
                : `Nothing matched on ${result.origin}. Try another seed, raise the depth, or enable both discovery sources.`}
            </ReadoutNote>
          </Readout>
        </>
      ) : null}
    </div>
  );
}
