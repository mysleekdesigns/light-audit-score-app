"use client";

import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import {
  Crosshair,
  Gauge,
  ListPlus,
  Play,
  Radar,
  TriangleAlert,
} from "lucide-react";

import { parseUrls } from "@/lib/parseUrls";
import type { CreateBatchRequest } from "@/lib/client/auditClient";
import { CrawlPanel } from "@/components/audit/crawl-panel";
import { RunConfigCard } from "@/components/audit/run-config-card";
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
import { CATEGORY_LABELS } from "@/lib/scores";
import {
  clampCpuMultiplier,
  MATCH_DEVTOOLS_PRESET,
} from "@/lib/settings/defaults";
import { useAuditDefaults } from "@/hooks/useAuditDefaults";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldContent,
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
   * Live results panel rendered in the left column beneath the Target URLs
   * card, filling the space alongside the (taller) Run config column. Null
   * until a batch exists.
   */
  results?: ReactNode;
}

export function NewAuditForm({
  onSubmit,
  isRunning = false,
  latestBenchmarkIndex = null,
  results = null,
}: NewAuditFormProps) {
  const deviceId = useId();
  const throttlingId = useId();
  const runsId = useId();
  const concurrencyId = useId();
  const cpuId = useId();
  const accuracyId = useId();

  // Persisted run defaults (device / runs / concurrency / categories). The first
  // render must match SSR, so we keep the hardcoded initial state below and only
  // adopt persisted values once `loaded` flips true (one-time hydration effect).
  const { defaults, update, loaded } = useAuditDefaults();

  const [tab, setTab] = useState<"paste" | "crawl">("paste");
  const [text, setText] = useState("");
  // URLs the crawl panel currently has selected. The panel owns discovery; this
  // form only needs the resolved selected set so it can submit the active tab's
  // URLs through the same CreateBatchRequest the paste tab uses.
  const [crawlUrls, setCrawlUrls] = useState<string[]>([]);
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
  }

  const { urls: pastedUrls, invalid } = useMemo(() => parseUrls(text), [text]);

  // The active tab is the single source of truth for what gets submitted.
  const urls = tab === "paste" ? pastedUrls : crawlUrls;

  const canSubmit = urls.length > 0 && !isRunning;

  // Calibration is pure + cheap, but memoised so the derived recommendation is a
  // stable reference for the readout card across unrelated re-renders.
  const calibration = useMemo(
    () => calibrationFor(latestBenchmarkIndex),
    [latestBenchmarkIndex],
  );

  // Stable callback so the crawl panel's reporting effect doesn't re-fire.
  const handleCrawlUrlsChange = useCallback((next: string[]) => {
    setCrawlUrls(next);
  }, []);

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

  function handleConcurrencyChange(value: string) {
    const next = Number(value);
    setConcurrency(next);
    update({ concurrency: next });
  }

  function handleCpuChange(value: string) {
    const next = cpuFromSelectValue(value);
    setCpuSlowdownMultiplier(next);
    update({ cpuSlowdownMultiplier: next });
  }

  function handleAccuracyModeChange(next: boolean) {
    setAccuracyMode(next);
    update({ accuracyMode: next });
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
   * concurrency 1 · accuracy on · Auto 4×) to both local state and the persisted
   * defaults, so the next run is directly comparable to a DevTools-panel run.
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
      },
      concurrency,
      accuracyMode,
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Dense horizontal control bar — every run-config lever in one instrument
          toolbar so the textarea + live results below get the full width. */}
      <Card>
        <CardHeader className="gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <CardTitle>Run config</CardTitle>
            <CardDescription className="font-mono text-[0.65rem] uppercase tracking-[0.18em]">
              The biggest levers on score accuracy.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Row 1: the controls, re-flowed into a wrapping grid that goes dense
              on wide screens. Each cell keeps its own label + handler + wiring. */}
          <div className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            <Field>
              <FieldLabel htmlFor={deviceId}>Device</FieldLabel>
              <ToggleGroup
                id={deviceId}
                type="single"
                variant="outline"
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

            <Field>
              <FieldLabel htmlFor={throttlingId}>Throttling</FieldLabel>
              <ToggleGroup
                id={throttlingId}
                type="single"
                variant="outline"
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

            <Field orientation="horizontal" className="items-end">
              <FieldContent>
                <FieldLabel htmlFor={accuracyId}>Accuracy mode</FieldLabel>
              </FieldContent>
              <Toggle
                id={accuracyId}
                variant="outline"
                size="sm"
                pressed={accuracyMode}
                onPressedChange={handleAccuracyModeChange}
                disabled={isRunning}
                aria-label="Accuracy mode"
                className="shrink-0 font-mono text-[0.65rem] uppercase tracking-[0.18em] data-[state=on]:bg-score-good/15 data-[state=on]:text-score-good data-[state=on]:border-score-good/40"
              >
                {accuracyMode ? "On" : "Off"}
              </Toggle>
            </Field>
          </div>

          <Separator />

          {/* Row 2: categories + parity (calibration readout + Calibrate /
              Match-DevTools), flowing horizontally on wide screens. */}
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
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

            <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
              <RunConfigCard
                throttling={throttling}
                cpuSlowdownMultiplier={cpuSlowdownMultiplier}
                calibration={calibration}
              />
              <div className="flex shrink-0 flex-col gap-2 sm:justify-center">
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
              </div>
            </div>
          </div>

          <Alert>
            <TriangleAlert className="text-score-average" />
            <AlertDescription>
              High concurrency causes CPU contention that distorts performance
              scores. Keep it low for trustworthy numbers.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Targets — full width — with the primary action, then the live results. */}
      <Card>
        <CardHeader>
          <CardTitle>Target URLs</CardTitle>
          <CardDescription>
            One URL per line. Each is audited independently.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={tab} onValueChange={handleTabChange} className="gap-4">
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

            <TabsContent value="paste" className="flex flex-col gap-3">
              <Textarea
                rows={10}
                value={text}
                onChange={(event) => setText(event.target.value)}
                disabled={isRunning}
                aria-label="Target URLs"
                spellCheck={false}
                autoComplete="off"
                className="resize-none font-mono text-sm"
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
                onUrlsChange={handleCrawlUrlsChange}
                disabled={isRunning}
              />
            </TabsContent>
          </Tabs>
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

      {results}
    </div>
  );
}
