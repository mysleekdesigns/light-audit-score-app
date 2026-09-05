"use client";

/**
 * PageSpeed Insights input form (PSI feature) — the lean sibling of
 * {@link NewAuditForm}. Same "precision instrument" panel and the same paste /
 * crawl URL sources ({@link CrawlPanel} reused verbatim). It exposes the levers
 * that mean something for PSI: device (→ strategy), categories, report locale,
 * runs-per-URL, and concurrency.
 *
 * Runs-per-URL is a CLIENT-SIDE median-of-N: the engine makes N PSI API calls and
 * takes the median (PSI lab scores vary call-to-call). Concurrency is how many
 * URLs are analysed in parallel (parallel API requests). CPU slowdown / throttling
 * / warm-cache are intentionally absent — PSI's lab conditions are fixed
 * Google-side and its API accepts no such parameter, so a control would be a no-op.
 *
 * Layout mirrors {@link NewAuditForm}'s instrument bands: Targets grows to fill
 * its column (so the two halves end level), and the config panel is a 1/2/4-wide
 * dial grid, a full-width Categories band, and an `mt-auto` instrument footer
 * holding the quota readout ({@link PsiConfigCard}) and Save as daily in one
 * bezel. Because PSI's lab conditions are fixed, the footer reports what the
 * batch *costs* rather than how accurate it is — see {@link psiRequestCost}.
 *
 * Submits the exact same {@link CreateBatchRequest} the local form does, tagged
 * with `source: "psi"`, so it flows through the one queue / SSE / results
 * pipeline. The parent ({@link PageSpeedConsole}) renders the live results slot.
 */

import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import {
  CalendarPlus,
  CircleCheck,
  Info,
  ListPlus,
  Play,
  Radar,
  TriangleAlert,
} from "lucide-react";

import { CrawlPanel } from "@/components/audit/crawl-panel";
import { PsiConfigCard } from "@/components/pagespeed/psi-config-card";
import {
  WorkspacePanel,
  type WorkspaceView,
} from "@/components/audit/workspace-panel";
import type { DiscoverySelection } from "@/components/audit/discovered-urls-panel";
import { SaveScheduleDialog } from "@/components/archive/save-schedule-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import type { CreateBatchRequest } from "@/lib/client/auditClient";
import {
  LIGHTHOUSE_CATEGORIES,
  MAX_RUNS,
  MIN_RUNS,
  type AuditOptions,
  type DeviceSelection,
  type LighthouseCategory,
} from "@/lib/lighthouse/types";
import { parseUrls } from "@/lib/parseUrls";
import {
  PSI_REQUESTS_PER_DAY,
  PSI_REQUESTS_PER_MINUTE,
  psiRequestCost,
} from "@/lib/pagespeed/quota";
import { MAX_CONCURRENCY, MIN_CONCURRENCY } from "@/lib/queue/types";
import type { ScheduleTarget } from "@/lib/schedules/types";
import { selectedUrls, type DiscoverResult } from "@/lib/crawl/types";
import { samplePerTemplate } from "@/lib/crawl/template";
import { useAuditDefaults } from "@/hooks/useAuditDefaults";
import { usePsiAuditDraft } from "@/hooks/useAuditDraft";
import { PSI_LOCALE_DEFAULT as LOCALE_DEFAULT } from "@/lib/settings/drafts";
import { CATEGORY_LABELS } from "@/lib/scores";

/**
 * A small curated set of PSI report locales (the API accepts many more).
 * `LOCALE_DEFAULT` is the "no locale override" sentinel, shared with the draft
 * contract so a restored draft and this list agree.
 */
const LOCALES: { value: string; label: string }[] = [
  { value: LOCALE_DEFAULT, label: "Default locale" },
  { value: "en_US", label: "English (US)" },
  { value: "en_GB", label: "English (UK)" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt_BR", label: "Portuguese (BR)" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
];

/** Runs-per-URL choices (median-of-N). Each run is one PSI API call. */
const RUN_OPTIONS = Array.from(
  { length: MAX_RUNS - MIN_RUNS + 1 },
  (_, i) => MIN_RUNS + i,
);

/** Parallel-URL choices. Bounded by Google's PSI rate limits (~240/min). */
const CONCURRENCY_OPTIONS = Array.from(
  { length: MAX_CONCURRENCY - MIN_CONCURRENCY + 1 },
  (_, i) => MIN_CONCURRENCY + i,
);

export interface PsiAuditFormProps {
  /** Called with a ready-to-send PSI batch request when the user runs it. */
  onSubmit: (request: CreateBatchRequest) => void;
  /** When true, the form locks and the run button shows a running state. */
  isRunning?: boolean;
  /** Live results node rendered full-width in the workspace. Null until a batch exists. */
  results?: ReactNode;
  /** Whether a batch exists — drives the workspace's results-vs-discovered switch. */
  hasBatch?: boolean;
}

export function PsiAuditForm({
  onSubmit,
  isRunning = false,
  results = null,
  hasBatch = false,
}: PsiAuditFormProps) {
  const deviceId = useId();
  const localeId = useId();
  const runsId = useId();
  const concurrencyId = useId();

  // The whole editable form — targets (URL list, active tab, discovered pages +
  // selection, last workspace intent) AND this form's dials — is a per-tab draft
  // rather than component state, so leaving the page and coming back (or
  // reloading) shows it exactly as it was left while the batch keeps running
  // (see `@/lib/settings/drafts`). Unlike the local form, these dials aren't
  // remembered in the shared audit defaults, so the draft carries them. Crawl
  // state is lifted so the curation list renders full-width in the workspace
  // below (mirrors NewAuditForm); the panel only triggers discovery.
  const [draft, updateDraft] = usePsiAuditDraft();
  const { tab, text, workspaceView, device, categories, locale, runs, concurrency } =
    draft;
  const crawlResult = draft.crawl?.result ?? null;
  const crawlSelected = useMemo<Set<string>>(
    () => new Set(draft.crawl?.selected ?? []),
    [draft.crawl],
  );
  const setTab = useCallback(
    (next: "paste" | "crawl") => updateDraft((d) => ({ ...d, tab: next })),
    [updateDraft],
  );
  const setText = useCallback(
    (next: string) => updateDraft((d) => ({ ...d, text: next })),
    [updateDraft],
  );
  const setWorkspaceView = useCallback(
    (next: "discovered" | "results") =>
      updateDraft((d) => ({ ...d, workspaceView: next })),
    [updateDraft],
  );
  const setDevice = useCallback(
    (next: DeviceSelection) => updateDraft((d) => ({ ...d, device: next })),
    [updateDraft],
  );
  const setCategories = useCallback(
    (next: LighthouseCategory[]) =>
      updateDraft((d) => ({ ...d, categories: next })),
    [updateDraft],
  );
  const setLocale = useCallback(
    (next: string) => updateDraft((d) => ({ ...d, locale: next })),
    [updateDraft],
  );
  const setRuns = useCallback(
    (next: number) => updateDraft((d) => ({ ...d, runs: next })),
    [updateDraft],
  );
  const setConcurrency = useCallback(
    (next: number) => updateDraft((d) => ({ ...d, concurrency: next })),
    [updateDraft],
  );
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // Per-template sampling cap (0 = All) — the one persisted, cross-tool default
  // this lean form shares with the local audit form. Hydrated below once the
  // settings hook has read localStorage (guarded so SSR stays on the default).
  const { defaults, update, loaded } = useAuditDefaults();
  const [pagesPerTemplate, setPagesPerTemplate] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  if (loaded && !hydrated) {
    setHydrated(true);
    setPagesPerTemplate(defaults.pagesPerTemplate);
  }

  const { urls: pastedUrls, invalid } = useMemo(() => parseUrls(text), [text]);
  // Crawl tab URLs = the selected subset of the discovered set, discovery order.
  const crawlUrls = useMemo(
    () => (crawlResult ? selectedUrls(crawlResult.urls, crawlSelected) : []),
    [crawlResult, crawlSelected],
  );
  const urls = tab === "paste" ? pastedUrls : crawlUrls;
  const canSubmit = urls.length > 0 && !isRunning;
  const canSaveSchedule = urls.length > 0 && !isRunning;

  // What this batch costs against Google's quota (`runs × strategies × targets`).
  // The instrument footer reads it twice — once as readout cells, once as the
  // state-aware quota alert — so it is derived here and shared.
  const cost = useMemo(
    () => psiRequestCost(device, runs, urls.length),
    [device, runs, urls.length],
  );

  // Resolved options for both submit and "Save as daily". `runs` drives the
  // client-side median-of-N (N PSI API calls); throttling / warmCache are nominal
  // (PSI ignores them — its lab conditions are fixed Google-side).
  const psiOptions = useMemo<AuditOptions>(
    () => ({
      formFactor: device === "both" ? "mobile" : device,
      throttling: "simulated",
      categories,
      runs,
      warmCache: true,
      locale: locale === LOCALE_DEFAULT ? undefined : locale,
    }),
    [device, categories, locale, runs],
  );

  const scheduleTarget = useMemo<ScheduleTarget>(
    () => ({ kind: "urls", urls }),
    [urls],
  );

  const handleDiscover = useCallback(
    (result: DiscoverResult) => {
      updateDraft((d) => ({
        ...d,
        crawl: {
          result,
          selected: [...samplePerTemplate(result.urls, pagesPerTemplate)],
        },
        workspaceView: "discovered",
      }));
    },
    [pagesPerTemplate, updateDraft],
  );

  // Re-sample the discovered set when the cap changes, and remember the choice.
  const handlePagesPerTemplateChange = useCallback(
    (n: number) => {
      setPagesPerTemplate(n);
      update({ pagesPerTemplate: n });
      updateDraft((d) =>
        d.crawl
          ? {
              ...d,
              crawl: {
                ...d.crawl,
                selected: [...samplePerTemplate(d.crawl.result.urls, n)],
              },
            }
          : d,
      );
    },
    [update, updateDraft],
  );

  const toggleCrawlUrl = useCallback(
    (url: string) => {
      updateDraft((d) => {
        if (!d.crawl) return d;
        const selected = d.crawl.selected.includes(url)
          ? d.crawl.selected.filter((u) => u !== url)
          : [...d.crawl.selected, url];
        return { ...d, crawl: { ...d.crawl, selected } };
      });
    },
    [updateDraft],
  );

  const removeCrawlUrl = useCallback(
    (url: string) => {
      updateDraft((d) =>
        d.crawl
          ? {
              ...d,
              crawl: {
                result: {
                  ...d.crawl.result,
                  urls: d.crawl.result.urls.filter((u) => u.url !== url),
                },
                selected: d.crawl.selected.filter((u) => u !== url),
              },
            }
          : d,
      );
    },
    [updateDraft],
  );

  const toggleAllCrawlUrls = useCallback(() => {
    updateDraft((d) => {
      if (!d.crawl || d.crawl.result.urls.length === 0) return d;
      return {
        ...d,
        crawl: {
          ...d.crawl,
          selected:
            d.crawl.selected.length >= d.crawl.result.urls.length
              ? []
              : d.crawl.result.urls.map((u) => u.url),
        },
      };
    });
  }, [updateDraft]);

  const crawlSelection = useMemo<DiscoverySelection | null>(
    () =>
      crawlResult
        ? {
            result: crawlResult,
            selected: crawlSelected,
            toggleOne: toggleCrawlUrl,
            toggleAll: toggleAllCrawlUrls,
            removeOne: removeCrawlUrl,
          }
        : null,
    [
      crawlResult,
      crawlSelected,
      toggleCrawlUrl,
      toggleAllCrawlUrls,
      removeCrawlUrl,
    ],
  );

  const resolvedView: WorkspaceView =
    workspaceView === "results" && hasBatch
      ? "results"
      : workspaceView === "discovered" && crawlResult && tab === "crawl"
        ? "discovered"
        : hasBatch
          ? "results"
          : "idle";

  function handleTabChange(value: string) {
    if (value === "paste" || value === "crawl") setTab(value);
  }

  function handleDeviceChange(value: string) {
    if (value === "mobile" || value === "desktop" || value === "both") {
      setDevice(value);
    }
  }

  function handleCategoriesChange(value: string[]) {
    if (value.length === 0) return; // keep at least one selected
    setCategories(LIGHTHOUSE_CATEGORIES.filter((c) => value.includes(c)));
  }

  function handleRunsChange(value: string) {
    const n = Number(value);
    if (Number.isFinite(n)) setRuns(n);
  }

  function handleConcurrencyChange(value: string) {
    const n = Number(value);
    if (Number.isFinite(n)) setConcurrency(n);
  }

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit({ urls, device, source: "psi", options: psiOptions, concurrency });
    setWorkspaceView("results");
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="px-4">
          <div className="grid gap-0 min-[1440px]:grid-cols-2">
            {/* Targets — left/top. Container query so the section adapts to its
                own column width when it shares the row with PageSpeed config. */}
            <section
              aria-labelledby="psi-targets-heading"
              className="@container flex flex-col gap-5 pb-6 min-[1440px]:pb-0 min-[1440px]:pr-6"
            >
              <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2
                  id="psi-targets-heading"
                  className="font-heading text-base font-medium leading-snug"
                >
                  Target URLs
                </h2>
                {/* The caption describes the *active* input mode — "one URL per
                    line" is meaningless once you're seeding a crawl. */}
                <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
                  {tab === "paste"
                    ? "One URL per line · analysed by Google"
                    : "Sitemap + link crawl · same-origin only"}
                </p>
              </header>
              {/* The tab body grows to fill the column so the paste textarea
                  absorbs whatever height the config panel needs beside it,
                  instead of leaving a void under a fixed 10-row box. */}
              <Tabs
                value={tab}
                onValueChange={handleTabChange}
                className="flex-1 gap-4"
              >
                <TabsList>
                  <TabsTrigger value="paste">
                    <ListPlus data-icon="inline-start" />
                    Paste list
                  </TabsTrigger>
                  <TabsTrigger value="crawl">
                    <Radar data-icon="inline-start" />
                    Crawl site
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="paste" className="flex flex-1 flex-col gap-3">
                  <Textarea
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    disabled={isRunning}
                    aria-label="Target URLs"
                    spellCheck={false}
                    autoComplete="off"
                    className="min-h-44 flex-1 resize-none font-mono text-sm"
                    placeholder={
                      "https://example.com\nhttps://example.com/pricing\nhttps://example.com/blog"
                    }
                  />
                  <div
                    aria-live="polite"
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
                  >
                    <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
                      {pastedUrls.length}{" "}
                      {pastedUrls.length === 1 ? "URL" : "URLs"} queued
                    </p>
                    {invalid.length > 0 ? (
                      <p className="font-mono text-xs uppercase tracking-[0.18em] text-score-average">
                        {invalid.length}{" "}
                        {invalid.length === 1 ? "line" : "lines"} ignored
                        <span className="text-muted-foreground/70 normal-case tracking-normal">
                          {" "}
                          ({invalid.map((entry) => `L${entry.line}`).join(", ")})
                        </span>
                      </p>
                    ) : null}
                  </div>
                </TabsContent>

                <TabsContent value="crawl">
                  <CrawlPanel
                    onDiscover={handleDiscover}
                    result={crawlResult}
                    pagesPerTemplate={pagesPerTemplate}
                    onPagesPerTemplateChange={handlePagesPerTemplateChange}
                    disabled={isRunning}
                  />
                </TabsContent>
              </Tabs>
            </section>

            {/* PageSpeed config — right/bottom. Rotating hairline: border-t at
                narrow (under Targets), border-l at ≥1440px (beside Targets).
                Container query so the dials and the categories band re-flow to
                this section's *own* width, not the viewport. */}
            <section
              aria-labelledby="psi-config-heading"
              className="@container flex flex-col gap-5 border-t border-border/60 pt-6 min-[1440px]:border-t-0 min-[1440px]:border-l min-[1440px]:pl-6 min-[1440px]:pt-0"
            >
              <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2
                  id="psi-config-heading"
                  className="font-heading text-base font-medium leading-snug"
                >
                  PageSpeed config
                </h2>
                <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
                  Google-hosted · fixed lab conditions
                </p>
              </header>

              {/* Dials. Four controls that divide evenly at every step: one
                  column on a phone, 2×2 once a half-cell can still hold the
                  Device segments (@lg = 512px), and a single 4-across
                  instrument row when the section is wide enough that 2-across
                  would stretch each dial past 400px (@5xl = 1024px). */}
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 @lg:grid-cols-2 @5xl:grid-cols-4">
                <Field>
                  <FieldLabel htmlFor={deviceId}>Device</FieldLabel>
                  <ToggleGroup
                    id={deviceId}
                    type="single"
                    variant="outline"
                    spacing={0}
                    // The FieldLabel is a <label>, which can't name a role=group
                    // div — the group needs its own accessible name.
                    aria-label="Device"
                    value={device}
                    onValueChange={handleDeviceChange}
                    disabled={isRunning}
                    className="w-full"
                  >
                    <ToggleGroupItem value="mobile" className="flex-1">
                      Mobile
                    </ToggleGroupItem>
                    <ToggleGroupItem value="desktop" className="flex-1">
                      Desktop
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="both"
                      className="flex-1"
                      title="Analyze each URL on mobile and desktop"
                    >
                      Both
                    </ToggleGroupItem>
                  </ToggleGroup>
                </Field>

                <Field>
                  <FieldLabel htmlFor={localeId}>Report locale</FieldLabel>
                  <Select
                    value={locale}
                    onValueChange={setLocale}
                    disabled={isRunning}
                  >
                    <SelectTrigger id={localeId} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {LOCALES.map((l) => (
                          <SelectItem key={l.value} value={l.value}>
                            {l.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>

                <Field>
                  <FieldLabel htmlFor={runsId}>Runs per URL</FieldLabel>
                  <Select
                    value={String(runs)}
                    onValueChange={handleRunsChange}
                    disabled={isRunning}
                  >
                    <SelectTrigger
                      id={runsId}
                      className="w-full"
                      title="Median of N PageSpeed runs — each run is one API call (quota = runs × URLs)."
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {RUN_OPTIONS.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n} {n === 1 ? "run" : "runs"} (median)
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>

                <Field>
                  <FieldLabel htmlFor={concurrencyId}>Concurrency</FieldLabel>
                  <Select
                    value={String(concurrency)}
                    onValueChange={handleConcurrencyChange}
                    disabled={isRunning}
                  >
                    <SelectTrigger
                      id={concurrencyId}
                      className="w-full"
                      title="How many URLs are analysed in parallel — capped by Google's PSI rate limits (~240 requests/min)."
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {CONCURRENCY_OPTIONS.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n} parallel
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <Separator />

              {/* Scope band — what each run measures. The categories used to
                  wrap as small chips beside a far-right orphaned action; as
                  full-width pills the whole cell is the tap target and the band
                  fills the section instead of trailing off. The column count
                  climbs 1 → 2 → 3 → one-per-category, so five pills never get
                  crammed into a phone-width row and the widest label ("Agentic
                  Browsing") always has room to sit on one line. */}
              <FieldSet className="gap-2">
                <FieldLegend variant="label">Categories</FieldLegend>
                <ToggleGroup
                  type="multiple"
                  variant="outline"
                  aria-label="Categories"
                  value={categories}
                  onValueChange={handleCategoriesChange}
                  disabled={isRunning}
                  style={
                    { "--cat-cols": LIGHTHOUSE_CATEGORIES.length } as React.CSSProperties
                  }
                  className="grid w-full grid-cols-1 gap-2 @xs:grid-cols-2 @lg:grid-cols-3 @3xl:grid-cols-[repeat(var(--cat-cols),minmax(0,1fr))]"
                >
                  {LIGHTHOUSE_CATEGORIES.map((category) => (
                    <ToggleGroupItem
                      key={category}
                      value={category}
                      className="w-full font-normal data-[state=on]:text-foreground"
                    >
                      {CATEGORY_LABELS[category]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </FieldSet>

              {/* Instrument footer, pinned to the bottom of the panel (`mt-auto`)
                  so the section reads as a console with a status bar rather than
                  trailing off into dead space beside the taller Targets column.
                  PSI's lab conditions are fixed, so what the footer reports is
                  what the batch *costs*: the quota alert tracks the live figure
                  instead of restating the same paragraph every time. */}
              <div className="mt-auto flex flex-col gap-3 pt-2">
                {/* ONE <Alert> whose contents change, not three that swap: a
                    live region has to already be in the DOM when its text
                    changes for a screen reader to announce it. `polite` also
                    overrides the component's role=alert assertiveness, since
                    this only ever tracks a dial the user just turned. */}
                <Alert aria-live="polite">
                  {urls.length === 0 ? (
                    <Info />
                  ) : cost.overBurst ? (
                    <TriangleAlert className="text-score-average" />
                  ) : (
                    <CircleCheck className="text-score-good" />
                  )}
                  <AlertDescription>
                    {urls.length === 0 ? (
                      <>
                        Each URL costs {cost.perUrl} API{" "}
                        {cost.perUrl === 1 ? "call" : "calls"}{" "}
                        &mdash; runs × strategies &mdash; against Google&rsquo;s
                        quota (~{PSI_REQUESTS_PER_MINUTE}/min,{" "}
                        {PSI_REQUESTS_PER_DAY.toLocaleString("en-US")}/day). Set{" "}
                        <code className="font-mono text-[0.8em]" translate="no">
                          PAGESPEED_API_KEY
                        </code>{" "}
                        for headroom.
                      </>
                    ) : cost.overBurst ? (
                      <>
                        {cost.total}{" "}
                        requests exceeds PageSpeed&rsquo;s ~
                        {PSI_REQUESTS_PER_MINUTE}/min burst, so Google will
                        throttle this batch. Lower runs per URL, or split the
                        targets.
                      </>
                    ) : (
                      <>
                        {cost.total}{" "}
                        requests &mdash; inside PageSpeed&rsquo;s ~
                        {PSI_REQUESTS_PER_MINUTE}/min burst and{" "}
                        {PSI_REQUESTS_PER_DAY.toLocaleString("en-US")}/day quota.
                      </>
                    )}
                  </AlertDescription>
                </Alert>

                <PsiConfigCard
                  device={device}
                  runs={runs}
                  targetCount={urls.length}
                  actions={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setScheduleOpen(true)}
                      disabled={!canSaveSchedule}
                      title={
                        canSaveSchedule
                          ? "Save these URLs + options as a daily PageSpeed schedule"
                          : "Add at least one URL before saving as daily"
                      }
                    >
                      <CalendarPlus data-icon="inline-start" />
                      Save as daily
                    </Button>
                  }
                />
              </div>
            </section>
          </div>
        </CardContent>
        <CardFooter className="flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-center font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground sm:text-left">
            {urls.length > 0
              ? `${urls.length} ${urls.length === 1 ? "target" : "targets"} ready`
              : tab === "paste"
                ? "Paste at least one URL to begin"
                : "Discover and select at least one URL to begin"}
          </p>
          <Button
            type="button"
            className="sm:w-auto sm:min-w-44"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {isRunning ? (
              <>
                <Spinner data-icon="inline-start" />
                Running…
              </>
            ) : (
              <>
                <Play data-icon="inline-start" />
                Run PageSpeed
              </>
            )}
          </Button>
        </CardFooter>
      </Card>

      <WorkspacePanel
        view={resolvedView}
        selection={crawlSelection}
        results={results}
        disabled={isRunning}
      />

      <SaveScheduleDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        target={scheduleTarget}
        options={psiOptions}
        concurrency={concurrency}
        device={device}
        accuracyMode={false}
        source="psi"
      />
    </div>
  );
}
