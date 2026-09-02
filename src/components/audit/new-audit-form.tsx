"use client";

import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import {
  CalendarPlus,
  CircleCheck,
  Crosshair,
  Gauge,
  ListPlus,
  Play,
  Radar,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { parseUrls } from "@/lib/parseUrls";
import type { CreateBatchRequest } from "@/lib/client/auditClient";
import { selectedUrls, type DiscoverResult } from "@/lib/crawl/types";
import { samplePerTemplate } from "@/lib/crawl/template";
import { CrawlPanel } from "@/components/audit/crawl-panel";
import {
  WorkspacePanel,
  type WorkspaceView,
} from "@/components/audit/workspace-panel";
import type { DiscoverySelection } from "@/components/audit/discovered-urls-panel";
import { RunConfigCard } from "@/components/audit/run-config-card";
import { SaveScheduleDialog } from "@/components/archive/save-schedule-dialog";
import type { ScheduleTarget } from "@/lib/schedules/types";
import type {
  DeviceSelection,
  LighthouseCategory,
  Throttling,
} from "@/lib/lighthouse/types";
import {
  LIGHTHOUSE_CATEGORIES,
  MAX_RUNS,
  MIN_RUNS,
} from "@/lib/lighthouse/types";
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
} from "@/lib/queue/types";
import { calibrationFor } from "@/lib/lighthouse/calibrate";
import {
  type UserAgentPreset,
  USER_AGENT_PRESETS,
  USER_AGENT_PRESET_LABELS,
  resolveUserAgentPreset,
  sanitizeUserAgentPreset,
} from "@/lib/lighthouse/user-agents";
import { CATEGORY_LABELS } from "@/lib/scores";
import {
  clampCpuMultiplier,
  MATCH_DEVTOOLS_PRESET,
} from "@/lib/settings/defaults";
import { useAuditDefaults } from "@/hooks/useAuditDefaults";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Field,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
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
import { Toggle } from "@/components/ui/toggle";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";

/** Range helper: inclusive integer list `from..to`. */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const RUN_OPTIONS = range(MIN_RUNS, MAX_RUNS);
const CONCURRENCY_OPTIONS = range(MIN_CONCURRENCY, MAX_CONCURRENCY);

/**
 * Sentinel `<Select>` value standing in for "no pinned multiplier" — Lighthouse
 * applies its own 4× (exactly the DevTools panel default). Select values must be
 * strings, so we map this to `cpuSlowdownMultiplier: undefined` on the way out.
 */
const CPU_AUTO = "auto";
/** Discrete CPU-multiplier choices offered in the picker (all within the engine band). */
const CPU_OPTIONS = [1, 2, 4, 6, 8, 10] as const;

/** Map the form's CPU multiplier (possibly undefined) to its `<Select>` value. */
function cpuSelectValue(multiplier: number | undefined): string {
  return typeof multiplier === "number" ? String(multiplier) : CPU_AUTO;
}

/** Map a `<Select>` value back to a clamped multiplier, or `undefined` for Auto. */
function cpuFromSelectValue(value: string): number | undefined {
  if (value === CPU_AUTO) return undefined;
  return clampCpuMultiplier(Number(value));
}

export interface NewAuditFormProps {
  /** Called with a ready-to-send batch request when the user runs the audit. */
  onSubmit: (request: CreateBatchRequest) => void;
  /** When true, the form locks and the submit button shows a running state. */
  isRunning?: boolean;
  /**
   * `benchmarkIndex` of the most recent completed run (newest done job wins), or
   * null when no run has reported one yet. Drives the Calibrate affordance and
   * the Run-config readout (PRD §6 Phase 9). The form never fetches this itself.
   */
  latestBenchmarkIndex?: number | null;
  /**
   * Live results node (the `<AuditResults/>` element) rendered full-width in the
   * workspace below the input card. Null until a batch exists.
   */
  results?: ReactNode;
  /**
   * Whether a batch currently exists (running, completed, or restored). Drives
   * the workspace's results-vs-discovered switch — when true, the workspace
   * shows {@link NewAuditFormProps.results} unless the user has just discovered.
   */
  hasBatch?: boolean;
}

export function NewAuditForm({
  onSubmit,
  isRunning = false,
  latestBenchmarkIndex = null,
  results = null,
  hasBatch = false,
}: NewAuditFormProps) {
  const deviceId = useId();
  const throttlingId = useId();
  const runsId = useId();
  const concurrencyId = useId();
  const cpuId = useId();
  const userAgentId = useId();

  // Persisted run defaults (device / runs / concurrency / categories). The first
  // render must match SSR, so we keep the hardcoded initial state below and only
  // adopt persisted values once `loaded` flips true (one-time hydration effect).
  const { defaults, update, loaded } = useAuditDefaults();

  const [tab, setTab] = useState<"paste" | "crawl">("paste");
  const [text, setText] = useState("");
  // Crawl discovery state, lifted out of CrawlPanel so the curation list can
  // render full-width in the workspace below the card. The panel only triggers
  // discovery (reporting each result up); this form owns the result + selection.
  const [crawlResult, setCrawlResult] = useState<DiscoverResult | null>(null);
  const [crawlSelected, setCrawlSelected] = useState<Set<string>>(new Set());
  // Which readout the workspace shows. Set by the user's last intent (Discover /
  // Run); null until they act. Resolved against `hasBatch` + `tab` below.
  const [workspaceView, setWorkspaceView] = useState<
    "discovered" | "results" | null
  >(null);
  // Device selection (Phase 12): "mobile" | "desktop" | "both". "both" fans each
  // URL out into a mobile + a desktop job server-side.
  const [device, setDevice] = useState<DeviceSelection>("mobile");
  const [throttling, setThrottling] = useState<Throttling>("simulated");
  const [runs, setRuns] = useState(3);
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const [categories, setCategories] = useState<LighthouseCategory[]>([
    ...LIGHTHOUSE_CATEGORIES,
  ]);
  // Phase 9: CPU multiplier (undefined = Lighthouse's 4× default) + accuracy mode.
  const [cpuSlowdownMultiplier, setCpuSlowdownMultiplier] = useState<
    number | undefined
  >(undefined);
  const [accuracyMode, setAccuracyMode] = useState(false);
  // Best Practices parity levers: warm cache (default true) surfaced as a "Clear
  // storage" toggle (clearStorage = !warmCache), and an optional emulated-UA
  // preset for bot-sensitive sites (default = no override).
  const [warmCache, setWarmCache] = useState(true);
  const [userAgentPreset, setUserAgentPreset] =
    useState<UserAgentPreset>("default");
  // Per-template sampling cap for crawl discovery (0 = All). Persisted + shared
  // with the PSI form; drives the auto-selection of the discovered set.
  const [pagesPerTemplate, setPagesPerTemplate] = useState(0);

  // Seed device / runs / concurrency / categories from the persisted defaults
  // exactly once, the render after the hook has read localStorage (`loaded`
  // flips true). Adjusting state during render — guarded by a one-shot state
  // flag — is React's recommended pattern for adopting an external value, and
  // keeps the SSR/first render on the hardcoded defaults so there's no
  // hydration mismatch. The flag ensures we never fight the user's later edits.
  const [hydrated, setHydrated] = useState(false);
  if (loaded && !hydrated) {
    setHydrated(true);
    setDevice(defaults.formFactor);
    setThrottling(defaults.throttling);
    setRuns(defaults.runs);
    setConcurrency(defaults.concurrency);
    setCategories([...defaults.categories]);
    setCpuSlowdownMultiplier(defaults.cpuSlowdownMultiplier);
    setAccuracyMode(defaults.accuracyMode);
    setWarmCache(defaults.warmCache);
    setUserAgentPreset(defaults.userAgentPreset);
    setPagesPerTemplate(defaults.pagesPerTemplate);
  }

  const { urls: pastedUrls, invalid } = useMemo(() => parseUrls(text), [text]);

  // The crawl tab's URLs are the selected subset of the discovered set, in
  // discovery order — derived during render (no effect-sync round-trip).
  const crawlUrls = useMemo(
    () => (crawlResult ? selectedUrls(crawlResult.urls, crawlSelected) : []),
    [crawlResult, crawlSelected],
  );

  // The active tab is the single source of truth for what gets submitted.
  const urls = tab === "paste" ? pastedUrls : crawlUrls;

  const canSubmit = urls.length > 0 && !isRunning;

  // Calibration is pure + cheap, but memoised so the derived recommendation is a
  // stable reference for the readout card across unrelated re-renders.
  const calibration = useMemo(
    () => calibrationFor(latestBenchmarkIndex),
    [latestBenchmarkIndex],
  );

  // A fresh discovery: store the result, auto-select per the pages-per-template
  // cap (All by default → everything; the user curates down), and point the
  // workspace at the discovered table.
  const handleDiscover = useCallback(
    (result: DiscoverResult) => {
      setCrawlResult(result);
      setCrawlSelected(samplePerTemplate(result.urls, pagesPerTemplate));
      setWorkspaceView("discovered");
    },
    [pagesPerTemplate],
  );

  // Changing the cap re-samples the discovered set from scratch (an explicit
  // re-sample replaces any manual row tweaks — expected for this action) and
  // remembers the choice for next time.
  const handlePagesPerTemplateChange = useCallback(
    (n: number) => {
      setPagesPerTemplate(n);
      update({ pagesPerTemplate: n });
      if (crawlResult) setCrawlSelected(samplePerTemplate(crawlResult.urls, n));
    },
    [crawlResult, update],
  );

  const toggleCrawlUrl = useCallback((url: string) => {
    setCrawlSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }, []);

  const removeCrawlUrl = useCallback((url: string) => {
    // Drop it from both the visible set and the selection so it can't return.
    setCrawlResult((prev) =>
      prev ? { ...prev, urls: prev.urls.filter((u) => u.url !== url) } : prev,
    );
    setCrawlSelected((prev) => {
      const next = new Set(prev);
      next.delete(url);
      return next;
    });
  }, []);

  const toggleAllCrawlUrls = useCallback(() => {
    setCrawlSelected((prev) => {
      if (!crawlResult || crawlResult.urls.length === 0) return prev;
      const all = crawlResult.urls.length;
      return prev.size >= all
        ? new Set()
        : new Set(crawlResult.urls.map((u) => u.url));
    });
  }, [crawlResult]);

  // The single cohesive object the workspace's discovered view consumes.
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

  // Resolve the workspace view from the user's last intent, falling back to a
  // restored batch on mount (workspaceView still null) and gating the discovered
  // table to the crawl tab so the paste tab never shows it.
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
    // "both" audits each URL on mobile AND desktop (Phase 12).
    if (value === "mobile" || value === "desktop" || value === "both") {
      setDevice(value);
      // Remember this device for the next visit.
      update({ formFactor: value });
    }
  }

  function handleThrottlingChange(value: string) {
    // Guard the union before committing, then persist (Phase 9: throttling is now
    // a remembered default).
    if (value === "simulated" || value === "applied") {
      setThrottling(value);
      update({ throttling: value });
    }
  }

  function handleRunsChange(value: string) {
    const next = Number(value);
    setRuns(next);
    update({ runs: next });
  }

  // Concurrency and accuracy mode are one dial with two handles: accuracy mode
  // means one page at a time, so the two must always agree, and the Concurrency
  // dial — the control you can see — is what runs. They used to be independent,
  // and the queue quietly pinned an "8 parallel · accuracy on" run to 1.
  function handleConcurrencyChange(value: string) {
    const next = Number(value);
    setConcurrency(next);
    if (next > MIN_CONCURRENCY && accuracyMode) {
      setAccuracyMode(false);
      update({ concurrency: next, accuracyMode: false });
      toast.info(`Accuracy mode off — ${next} pages will run in parallel.`, {
        description: "Accuracy mode runs one page at a time, so the dial wins.",
      });
      return;
    }
    update({ concurrency: next });
  }

  function handleCpuChange(value: string) {
    const next = cpuFromSelectValue(value);
    setCpuSlowdownMultiplier(next);
    update({ cpuSlowdownMultiplier: next });
  }

  function handleAccuracyModeChange(next: boolean) {
    setAccuracyMode(next);
    if (next && concurrency > MIN_CONCURRENCY) {
      setConcurrency(MIN_CONCURRENCY);
      update({ accuracyMode: true, concurrency: MIN_CONCURRENCY });
      toast.info("Accuracy mode on — concurrency set to 1.", {
        description:
          "Pages run one at a time so parallel Chromes can't contend for CPU.",
      });
      return;
    }
    update({ accuracyMode: next });
  }

  // The toggle reads as "Clear storage" (cold first visit) — the inverse of warm
  // cache. On = clear storage between runs (warmCache false), matching the
  // DevTools panel default; Off = warm repeat-visit (warmCache true).
  function handleClearStorageChange(next: boolean) {
    setWarmCache(!next);
    update({ warmCache: !next });
  }

  function handleUserAgentChange(value: string) {
    const next = sanitizeUserAgentPreset(value);
    setUserAgentPreset(next);
    update({ userAgentPreset: next });
  }

  /**
   * Calibrate: reuse the latest completed run's `benchmarkIndex` (no server
   * benchmark) and adopt the recommended multiplier as the new default. The
   * trigger is disabled when no calibration is available, so this is safe.
   */
  function handleCalibrate() {
    if (!calibration) return;
    const next = clampCpuMultiplier(calibration.recommendedMultiplier);
    setCpuSlowdownMultiplier(next);
    update({ cpuSlowdownMultiplier: next });
  }

  /**
   * Match DevTools: apply the canonical panel preset (mobile · simulated · 1 run ·
   * concurrency 1 · accuracy on · Auto 4× · clear storage) to both local state and
   * the persisted defaults, so the next run is directly comparable to a clean
   * DevTools-panel run (which clears storage by default).
   */
  function handleMatchDevTools() {
    const preset = MATCH_DEVTOOLS_PRESET;
    if (preset.formFactor) setDevice(preset.formFactor);
    if (preset.throttling) setThrottling(preset.throttling);
    if (typeof preset.runs === "number") setRuns(preset.runs);
    if (typeof preset.concurrency === "number") setConcurrency(preset.concurrency);
    if (typeof preset.accuracyMode === "boolean") setAccuracyMode(preset.accuracyMode);
    // The preset deliberately clears any pinned multiplier (back to Auto 4×).
    setCpuSlowdownMultiplier(preset.cpuSlowdownMultiplier);
    // …and clears storage (cold first visit), matching the panel's own default.
    if (typeof preset.warmCache === "boolean") setWarmCache(preset.warmCache);
    update(preset);
  }

  function handleCategoriesChange(value: string[]) {
    // Never allow deselecting the last category — keep at least one selected.
    if (value.length === 0) return;
    // Preserve canonical category order regardless of toggle interaction order.
    const next = LIGHTHOUSE_CATEGORIES.filter((c) => value.includes(c));
    setCategories(next);
    update({ categories: next });
  }

  // Save-as-daily dialog — opened by a small affordance next to "Match DevTools"
  // (PRD §6 Phase 14). The dialog itself owns the POST + toast; here we only
  // gate on whether the active tab actually has a target ready.
  const [scheduleOpen, setScheduleOpen] = useState(false);

  // The schedule target seeded from the active tab. For the paste tab this is a
  // straightforward `urls` target. For the crawl tab we persist the *resolved*
  // discovered URLs (the panel doesn't surface its spec upstream), which the
  // scheduler will fire as-is — re-discovery on each fire is a future iteration.
  const scheduleTarget = useMemo<ScheduleTarget>(
    () => ({ kind: "urls", urls }),
    [urls],
  );

  const canSaveSchedule = urls.length > 0 && !isRunning;

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit({
      urls,
      // Top-level device selection drives the fan-out; "both" → mobile + desktop
      // jobs per URL (Phase 12). The server resolves it into per-job form factors.
      device,
      options: {
        // Keep options.formFactor a concrete base so the engine options stay
        // valid even for "both" (each job overrides it with its own device).
        formFactor: device === "both" ? "mobile" : device,
        throttling,
        categories,
        runs,
        // Omitted (undefined) → Lighthouse's own 4×, exactly the panel default.
        cpuSlowdownMultiplier,
        // Best Practices parity levers: warm/cold cache + optional UA override.
        warmCache,
        emulatedUserAgent: resolveUserAgentPreset(userAgentPreset),
      },
      concurrency,
      accuracyMode,
    });
    // Hand the workspace over to the live results readout.
    setWorkspaceView("results");
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Single instrument panel: Targets (primary input) + Run config (dials),
          divided by a hairline that rotates — horizontal at narrow, vertical at
          ≥1440px. The two sections split the row 50/50 when side by side, so the
          textarea / crawl panel and the dials each get half the width. One shared
          CardFooter governs both with the Run audit action. */}
      <Card>
        <CardContent className="px-4">
          <div className="grid gap-0 min-[1440px]:grid-cols-2">
            {/* Targets — left/top. Container query so the section adapts to its
                own column width when it shares the row with Run config. */}
            <section
              aria-labelledby="audit-targets-heading"
              className="@container flex flex-col gap-5 pb-6 min-[1440px]:pb-0 min-[1440px]:pr-6"
            >
              <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2
                  id="audit-targets-heading"
                  className="font-heading text-base font-medium leading-snug"
                >
                  Target URLs
                </h2>
                {/* The caption describes the *active* input mode — "one URL per
                    line" is meaningless once you're seeding a crawl. */}
                <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
                  {tab === "paste"
                    ? "One URL per line · audited independently"
                    : "Sitemap + link crawl · same-origin only"}
                </p>
              </header>
              {/* The tab body grows to fill the column so the paste textarea
                  absorbs whatever height Run config needs beside it, instead of
                  leaving a void under a fixed 10-row box. */}
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

            {/* Run config — right/bottom. Rotating hairline: border-t at narrow
                (under Targets), border-l at ≥1440px (beside Targets). Container
                query so the controls grid + categories row re-flow to this
                section's *own* width, not the viewport. */}
            <section
              aria-labelledby="audit-runconfig-heading"
              className="@container flex flex-col gap-5 border-t border-border/60 pt-6 min-[1440px]:border-t-0 min-[1440px]:border-l min-[1440px]:pl-6 min-[1440px]:pt-0"
            >
              <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2
                  id="audit-runconfig-heading"
                  className="font-heading text-base font-medium leading-snug"
                >
                  Run config
                </h2>
                <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
                  The biggest levers on score accuracy.
                </p>
              </header>

              {/* Dials. Six controls never read well in one 6-across row at
                  these column widths, so the grid tops out at 3 (two even rows —
                  which also gives the panel the height to sit beside Targets).
                  The two segmented controls need more room than a select, so
                  they span the full width while the grid is only 2 wide.
                  Thresholds: @sm=384px, @3xl=768px. */}
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 @sm:grid-cols-2 @3xl:grid-cols-3">
                <Field className="@sm:col-span-2 @lg:col-span-1">
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
                      title="Audit each URL on mobile and desktop"
                    >
                      Both
                    </ToggleGroupItem>
                  </ToggleGroup>
                </Field>

                <Field className="@sm:col-span-2 @lg:col-span-1">
                  <FieldLabel htmlFor={throttlingId}>Throttling</FieldLabel>
                  <ToggleGroup
                    id={throttlingId}
                    type="single"
                    variant="outline"
                    spacing={0}
                    aria-label="Throttling"
                    value={throttling}
                    onValueChange={handleThrottlingChange}
                    disabled={isRunning}
                    className="w-full"
                  >
                    <ToggleGroupItem value="simulated" className="flex-1">
                      Simulated
                    </ToggleGroupItem>
                    <ToggleGroupItem value="applied" className="flex-1">
                      Applied
                    </ToggleGroupItem>
                  </ToggleGroup>
                </Field>

                <Field>
                  <FieldLabel htmlFor={cpuId}>CPU slowdown</FieldLabel>
                  <Select
                    value={cpuSelectValue(cpuSlowdownMultiplier)}
                    onValueChange={handleCpuChange}
                    disabled={isRunning}
                  >
                    <SelectTrigger id={cpuId} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={CPU_AUTO}>
                          Auto (Lighthouse 4×)
                        </SelectItem>
                        {CPU_OPTIONS.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n}× slowdown
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
                    <SelectTrigger id={runsId} className="w-full">
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
                    <SelectTrigger id={concurrencyId} className="w-full">
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

                <Field>
                  <FieldLabel htmlFor={userAgentId}>User agent</FieldLabel>
                  <Select
                    value={userAgentPreset}
                    onValueChange={handleUserAgentChange}
                    disabled={isRunning}
                  >
                    <SelectTrigger
                      id={userAgentId}
                      className="w-full"
                      title="Override the emulated page user agent — helps bot-sensitive sites (e.g. Cloudflare) serve the same content they serve a real browser."
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {USER_AGENT_PRESETS.map((preset) => (
                          <SelectItem key={preset} value={preset}>
                            {USER_AGENT_PRESET_LABELS[preset]}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>

              </div>

              <Separator />

              {/* Scope band — what each run measures (Categories) and how it
                  measures it (the two boolean flags), side by side once the
                  section can hold two readable columns. The flags used to trail
                  the dial grid as two orphaned cells beside four empty ones; as
                  full-width pills the whole row is the tap target. */}
              <div className="grid gap-5 @3xl:grid-cols-2 @3xl:gap-x-8">
                <FieldSet className="gap-2">
                  <FieldLegend variant="label">Categories</FieldLegend>
                  <ToggleGroup
                    type="multiple"
                    variant="outline"
                    value={categories}
                    onValueChange={handleCategoriesChange}
                    disabled={isRunning}
                    className="flex-wrap"
                  >
                    {LIGHTHOUSE_CATEGORIES.map((category) => (
                      <ToggleGroupItem key={category} value={category} size="sm">
                        {CATEGORY_LABELS[category]}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </FieldSet>

                <FieldSet className="gap-2">
                  <FieldLegend variant="label">Run flags</FieldLegend>
                  <div className="grid grid-cols-1 gap-2 @xs:grid-cols-2">
                    <Toggle
                      variant="outline"
                      pressed={accuracyMode}
                      onPressedChange={handleAccuracyModeChange}
                      disabled={isRunning}
                      title="Runs one page at a time (sets Concurrency to 1) and discards outlier runs for the steadiest possible numbers."
                      className="w-full justify-between gap-3 px-3 font-normal data-[state=on]:border-score-good/40 data-[state=on]:bg-score-good/10 data-[state=on]:text-foreground"
                    >
                      Accuracy mode
                      <span
                        aria-hidden
                        className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground group-data-[state=on]/toggle:text-score-good"
                      >
                        {accuracyMode ? "On" : "Off"}
                      </span>
                    </Toggle>
                    <Toggle
                      variant="outline"
                      pressed={!warmCache}
                      onPressedChange={handleClearStorageChange}
                      disabled={isRunning}
                      title="On clears the HTTP cache between runs (cold first visit), matching the DevTools panel default. Off keeps a warm repeat-visit cache."
                      className="w-full justify-between gap-3 px-3 font-normal data-[state=on]:border-score-good/40 data-[state=on]:bg-score-good/10 data-[state=on]:text-foreground"
                    >
                      Clear storage
                      <span
                        aria-hidden
                        className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground group-data-[state=on]/toggle:text-score-good"
                      >
                        {!warmCache ? "On" : "Off"}
                      </span>
                    </Toggle>
                  </div>
                </FieldSet>
              </div>

              {/* Instrument footer, pinned to the bottom of the panel (`mt-auto`)
                  so the section reads as a console with a status bar rather than
                  trailing off into dead space beside the taller Targets column.
                  The contention note reflects the *chosen* concurrency instead of
                  warning unconditionally. */}
              <div className="mt-auto flex flex-col gap-3 pt-2">
                {/* The copy tracks the Concurrency dial, so the region announces
                    politely rather than interrupting with role=alert's default
                    assertiveness every time the user changes it. */}
                {concurrency > 1 ? (
                  <Alert aria-live="polite">
                    <TriangleAlert className="text-score-average" />
                    <AlertDescription>
                      {concurrency}{" "}
                      parallel runs contend for this machine&rsquo;s CPU, which
                      depresses performance scores. Lower it for trustworthy
                      numbers.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <Alert aria-live="polite">
                    <CircleCheck className="text-score-good" />
                    <AlertDescription>
                      {accuracyMode
                        ? "Accuracy mode — one page at a time, "
                        : "Serial runs — "}
                      no CPU contention. The most trustworthy numbers this
                      machine can produce.
                    </AlertDescription>
                  </Alert>
                )}

                <RunConfigCard
                  throttling={throttling}
                  cpuSlowdownMultiplier={cpuSlowdownMultiplier}
                  calibration={calibration}
                  actions={
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleCalibrate}
                        disabled={isRunning || !calibration}
                        title={
                          calibration
                            ? `Apply the recommended ${calibration.recommendedMultiplier}× for this host`
                            : "Run an audit first to read this host's benchmark"
                        }
                      >
                        <Gauge data-icon="inline-start" />
                        Calibrate
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleMatchDevTools}
                        disabled={isRunning}
                        title="Mobile · simulated · 1 run · concurrency 1 · accuracy on"
                      >
                        <Crosshair data-icon="inline-start" />
                        Match DevTools
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setScheduleOpen(true)}
                        disabled={!canSaveSchedule}
                        title={
                          canSaveSchedule
                            ? "Save these targets + options as a daily schedule"
                            : "Add at least one URL before saving as daily"
                        }
                      >
                        <CalendarPlus data-icon="inline-start" />
                        Save as daily
                      </Button>
                    </>
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
                Run audit
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
        options={{
          formFactor: device === "both" ? "mobile" : device,
          throttling,
          categories,
          runs,
          cpuSlowdownMultiplier,
          // Carry the chosen parity levers into the saved schedule's options.
          warmCache,
          emulatedUserAgent: resolveUserAgentPreset(userAgentPreset),
        }}
        concurrency={concurrency}
        device={device}
        accuracyMode={accuracyMode}
      />
    </div>
  );
}
