"use client";

/**
 * "Crawl site" tab body for the New Audit form (PRD §6 Phase 5).
 *
 * Turns a seed URL into an auditable URL set in two phases:
 *  1. Discover — collect same-origin URLs via sitemap parse + shallow BFS crawl
 *     (server-side, through {@link discoverSite}); surface count / cap / warnings
 *     / robots-blocked notices so the run is never a black box.
 *  2. Preview + edit — show every discovered URL as a selectable row (mono, with
 *     source + depth provenance) so the user curates the exact set *before* it
 *     hits the batch queue. The selected set is reported up via `onUrlsChange`.
 *
 * Composition seam: this panel is "controlled-enough" — it owns the discovery
 * result + selection internally (that's pure local UI state), but the *only*
 * thing the parent cares about is the resolved selected URL list, pushed through
 * the single `onUrlsChange` callback. The parent (`NewAuditForm`) feeds that list
 * into the exact same `CreateBatchRequest` the paste tab uses, so discovered URLs
 * flow through the existing batch queue with zero new contract. We deliberately
 * do NOT lift discovery state up: keeping it here lets the parent treat both tabs
 * uniformly (each tab is just "a source of `string[]`").
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CircleSlash,
  Network,
  Search,
  SquareCheckBig,
  SquareDashed,
  TriangleAlert,
  X,
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
  type DiscoveredUrl,
} from "@/lib/crawl/types";
import { ApiError } from "@/lib/client/auditClient";
import { cn } from "@/lib/utils";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
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
 * Parse the exclude-paths textarea into a clean `string[]`: one pattern per
 * line, trimmed, blank lines dropped. The route's zod schema is the validation
 * authority (rejects empties/over-long/too-many) — this just shapes the input.
 */
function parseExcludePaths(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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

/** Resolve the selected URL list from the current selection set, in discovery order. */
function selectedUrls(
  urls: readonly DiscoveredUrl[],
  selected: ReadonlySet<string>,
): string[] {
  return urls.filter((u) => selected.has(u.url)).map((u) => u.url);
}

export interface CrawlPanelProps {
  /**
   * Reports the currently-selected discovered URLs (deduped, discovery order).
   * Fires after each discovery and on every selection edit so the parent always
   * holds the live set. Empty array = nothing selected / nothing discovered yet.
   */
  onUrlsChange: (urls: string[]) => void;
  /** Locks inputs while a batch from this form is running. */
  disabled?: boolean;
}

export function CrawlPanel({ onUrlsChange, disabled = false }: CrawlPanelProps) {
  const seedId = useId();
  const depthId = useId();
  const pagesId = useId();
  const scopeId = useId();
  const excludeId = useId();
  const resultsId = useId();

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
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const useSitemap = scope.includes("sitemap");
  const useCrawl = scope.includes("crawl");

  // Push the live selected set up whenever it (or the discovered set) changes.
  // The parent treats this tab as a pure "source of string[]".
  useEffect(() => {
    onUrlsChange(result ? selectedUrls(result.urls, selected) : []);
  }, [result, selected, onUrlsChange]);

  const selectedCount = selected.size;
  const totalCount = result?.urls.length ?? 0;
  const allSelected = totalCount > 0 && selectedCount === totalCount;
  const truncated =
    result != null && result.totalFound > result.urls.length;

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
      setResult(res);
      // Select everything by default — the user curates down from the full set.
      setSelected(new Set(res.urls.map((u) => u.url)));
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
  }, [seed, useSitemap, useCrawl, depth, maxPages, excludeText]);

  function toggleOne(url: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  function removeOne(url: string) {
    // Remove from both the visible set and the selection so it can't return.
    setResult((prev) =>
      prev ? { ...prev, urls: prev.urls.filter((u) => u.url !== url) } : prev,
    );
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(url);
      return next;
    });
  }

  function toggleAll() {
    if (!result) return;
    setSelected(
      allSelected ? new Set() : new Set(result.urls.map((u) => u.url)),
    );
  }

  const submitLabel = useMemo(() => {
    if (!result) return null;
    if (selectedCount === 0) return "Select at least one URL to audit";
    return `${selectedCount} of ${totalCount} selected`;
  }, [result, selectedCount, totalCount]);

  return (
    <div className="flex flex-col gap-4">
      {/* Discovery controls */}
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={seedId}>Domain or seed URL</FieldLabel>
          <div className="flex items-center gap-2">
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
              variant="secondary"
              onClick={() => void handleDiscover()}
              disabled={disabled || isDiscovering || seed.trim().length === 0}
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
          <FieldDescription>
            Crawling stays same-origin. No scheme? We assume{" "}
            <span className="font-mono">https://</span>.
          </FieldDescription>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
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
            <FieldDescription>
              {useCrawl
                ? "Links followed from the seed."
                : "Enable “Crawl links” to follow pages."}
            </FieldDescription>
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
              className="font-mono text-sm tabular-nums"
            />
            <FieldDescription>
              Hard cap on discovered URLs ({MIN_PAGES}–{MAX_PAGES}).
            </FieldDescription>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor={scopeId}>Discovery sources</FieldLabel>
          <ToggleGroup
            id={scopeId}
            type="multiple"
            variant="outline"
            value={scope}
            onValueChange={handleScopeChange}
            disabled={disabled || isDiscovering}
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
          <FieldDescription>
            At least one source stays enabled.
          </FieldDescription>
        </Field>

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
            rows={3}
            className="font-mono text-xs"
            placeholder={"/admin/*\n/drafts\n*.pdf"}
          />
          <FieldDescription>
            One path per line. Prefix (
            <span className="font-mono">/blog</span>) or glob (
            <span className="font-mono">/admin/*</span>,{" "}
            <span className="font-mono">*.pdf</span>). Same-origin. Up to{" "}
            {MAX_EXCLUDE_PATHS}.
          </FieldDescription>
        </Field>
      </FieldGroup>

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

          {/* Selection header */}
          <div
            id={resultsId}
            aria-live="polite"
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
          >
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
              {selectedCount} of {totalCount} selected
              <span className="text-muted-foreground/70">
                {" · "}
                {result.totalFound} found
              </span>
            </p>
            {truncated ? (
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-score-average">
                Capped at {result.urls.length}
              </p>
            ) : null}
          </div>

          {totalCount > 0 ? (
            <div className="overflow-hidden rounded-lg border border-border/70">
              <div className="flex items-center justify-between gap-2 border-b border-border/70 bg-muted/30 px-2.5 py-1.5">
                <span className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
                  Discovered URLs
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={toggleAll}
                  disabled={disabled}
                  className="font-mono text-[0.65rem] uppercase tracking-[0.18em]"
                >
                  {allSelected ? (
                    <>
                      <SquareDashed data-icon="inline-start" />
                      Deselect all
                    </>
                  ) : (
                    <>
                      <SquareCheckBig data-icon="inline-start" />
                      Select all
                    </>
                  )}
                </Button>
              </div>
              <ScrollArea className="h-64">
                <ul className="divide-y divide-border/50">
                  {result.urls.map((item) => {
                    const isChecked = selected.has(item.url);
                    return (
                      <li
                        key={item.url}
                        className="flex items-center gap-2 px-2.5 py-1.5"
                      >
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={isChecked}
                          onClick={() => toggleOne(item.url)}
                          disabled={disabled}
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none disabled:cursor-not-allowed disabled:opacity-50",
                            "rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50",
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                              isChecked
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-input bg-transparent",
                            )}
                          >
                            {isChecked ? (
                              <svg
                                viewBox="0 0 16 16"
                                fill="none"
                                className="size-3"
                              >
                                <path
                                  d="M3.5 8.5l3 3 6-6.5"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            ) : null}
                          </span>
                          <span
                            className={cn(
                              "truncate font-mono text-xs",
                              isChecked
                                ? "text-foreground"
                                : "text-muted-foreground line-through decoration-border",
                            )}
                            title={item.url}
                          >
                            {item.url}
                          </span>
                        </button>
                        <Badge
                          variant={
                            item.source === "sitemap" ? "secondary" : "outline"
                          }
                          className="shrink-0 font-mono text-[0.6rem] uppercase tracking-[0.12em]"
                        >
                          {item.source}
                          {item.depth != null ? ` · d${item.depth}` : ""}
                        </Badge>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => removeOne(item.url)}
                          disabled={disabled}
                          aria-label={`Remove ${item.url}`}
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <X />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-1 rounded-md border border-dashed border-border/70 bg-muted/20 p-6">
              <CircleSlash className="size-5 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">
                No URLs to preview
              </p>
              <p className="text-sm text-muted-foreground">
                Try a different seed, raise the depth, or enable both discovery
                sources.
              </p>
            </div>
          )}

          {submitLabel ? (
            <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
              {submitLabel}
            </p>
          ) : null}
        </>
      ) : (
        <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border/70 bg-muted/20 p-6">
          <Network className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            Discover a site to build a list
          </p>
          <p className="text-sm text-muted-foreground">
            Enter a domain, then Discover. Sitemap + a shallow same-origin crawl
            populate the list — preview and trim it before auditing.
          </p>
        </div>
      )}
    </div>
  );
}
