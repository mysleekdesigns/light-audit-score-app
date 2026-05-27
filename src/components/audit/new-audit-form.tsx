"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { ListPlus, Play, Radar, TriangleAlert } from "lucide-react";

import { parseUrls } from "@/lib/parseUrls";
import type { CreateBatchRequest } from "@/lib/client/auditClient";
import { CrawlPanel } from "@/components/audit/crawl-panel";
import type {
  FormFactor,
  LighthouseCategory,
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
import { CATEGORY_LABELS } from "@/lib/scores";
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
  FieldDescription,
  FieldGroup,
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
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
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

export interface NewAuditFormProps {
  /** Called with a ready-to-send batch request when the user runs the audit. */
  onSubmit: (request: CreateBatchRequest) => void;
  /** When true, the form locks and the submit button shows a running state. */
  isRunning?: boolean;
}

export function NewAuditForm({ onSubmit, isRunning = false }: NewAuditFormProps) {
  const deviceId = useId();
  const runsId = useId();
  const concurrencyId = useId();

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
  const [formFactor, setFormFactor] = useState<FormFactor>("mobile");
  const [runs, setRuns] = useState(3);
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const [categories, setCategories] = useState<LighthouseCategory[]>([
    ...LIGHTHOUSE_CATEGORIES,
  ]);

  // Seed device / runs / concurrency / categories from the persisted defaults
  // exactly once, the render after the hook has read localStorage (`loaded`
  // flips true). Adjusting state during render — guarded by a one-shot state
  // flag — is React's recommended pattern for adopting an external value, and
  // keeps the SSR/first render on the hardcoded defaults so there's no
  // hydration mismatch. The flag ensures we never fight the user's later edits.
  const [hydrated, setHydrated] = useState(false);
  if (loaded && !hydrated) {
    setHydrated(true);
    setFormFactor(defaults.formFactor);
    setRuns(defaults.runs);
    setConcurrency(defaults.concurrency);
    setCategories([...defaults.categories]);
  }

  const { urls: pastedUrls, invalid } = useMemo(() => parseUrls(text), [text]);

  // The active tab is the single source of truth for what gets submitted.
  const urls = tab === "paste" ? pastedUrls : crawlUrls;

  const canSubmit = urls.length > 0 && !isRunning;

  // Stable callback so the crawl panel's reporting effect doesn't re-fire.
  const handleCrawlUrlsChange = useCallback((next: string[]) => {
    setCrawlUrls(next);
  }, []);

  function handleTabChange(value: string) {
    if (value === "paste" || value === "crawl") setTab(value);
  }

  function handleDeviceChange(value: string) {
    if (value === "mobile" || value === "desktop") {
      setFormFactor(value);
      // Remember this device for the next visit.
      update({ formFactor: value });
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
      options: {
        formFactor,
        throttling: "simulated",
        categories,
        runs,
      },
      concurrency,
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Targets */}
      <Card className="lg:col-span-2">
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
      </Card>

      {/* Run configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Run config</CardTitle>
          <CardDescription>
            The biggest levers on score accuracy.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={deviceId}>Device</FieldLabel>
              <ToggleGroup
                id={deviceId}
                type="single"
                variant="outline"
                value={formFactor}
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
              </ToggleGroup>
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
              <FieldDescription>
                Median of N smooths out ±5pt variance.
              </FieldDescription>
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

            <FieldSet>
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
              <FieldDescription>
                At least one category stays selected.
              </FieldDescription>
            </FieldSet>

            <Alert>
              <TriangleAlert className="text-score-average" />
              <AlertDescription>
                High concurrency causes CPU contention that distorts performance
                scores. Keep it low for trustworthy numbers.
              </AlertDescription>
            </Alert>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-2">
          <Button
            type="button"
            className="w-full"
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
          <p className="text-center font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
            {urls.length > 0
              ? `${urls.length} ${urls.length === 1 ? "target" : "targets"} ready`
              : tab === "paste"
                ? "Paste at least one URL to begin"
                : "Discover and select at least one URL to begin"}
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
