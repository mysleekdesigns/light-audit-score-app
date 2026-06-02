"use client";

/**
 * PageSpeed Insights input form (PSI feature) — the lean sibling of
 * {@link NewAuditForm}. Same "precision instrument" panel and the same paste /
 * crawl URL sources ({@link CrawlPanel} reused verbatim), but only the levers PSI
 * honours: device (→ strategy), categories, and report locale. PSI's lab
 * conditions are fixed Google-side, so the warm-cache / CPU / throttling / runs
 * dials don't apply and are intentionally absent.
 *
 * Submits the exact same {@link CreateBatchRequest} the local form does, tagged
 * with `source: "psi"`, so it flows through the one queue / SSE / results
 * pipeline. The parent ({@link PageSpeedConsole}) renders the live results slot.
 */

import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { CalendarPlus, Info, ListPlus, Play, Radar } from "lucide-react";

import { CrawlPanel } from "@/components/audit/crawl-panel";
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
  type AuditOptions,
  type DeviceSelection,
  type LighthouseCategory,
} from "@/lib/lighthouse/types";
import { parseUrls } from "@/lib/parseUrls";
import type { ScheduleTarget } from "@/lib/schedules/types";
import { CATEGORY_LABELS } from "@/lib/scores";

/** Sentinel `<Select>` value for "no locale override" (PSI default). */
const LOCALE_DEFAULT = "default";

/** A small curated set of PSI report locales (the API accepts many more). */
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

export interface PsiAuditFormProps {
  /** Called with a ready-to-send PSI batch request when the user runs it. */
  onSubmit: (request: CreateBatchRequest) => void;
  /** When true, the form locks and the run button shows a running state. */
  isRunning?: boolean;
  /** Live results panel rendered beneath the input card. Null until a batch exists. */
  results?: ReactNode;
}

export function PsiAuditForm({
  onSubmit,
  isRunning = false,
  results = null,
}: PsiAuditFormProps) {
  const deviceId = useId();
  const localeId = useId();

  const [tab, setTab] = useState<"paste" | "crawl">("paste");
  const [text, setText] = useState("");
  const [crawlUrls, setCrawlUrls] = useState<string[]>([]);
  const [device, setDevice] = useState<DeviceSelection>("mobile");
  const [categories, setCategories] = useState<LighthouseCategory[]>([
    ...LIGHTHOUSE_CATEGORIES,
  ]);
  const [locale, setLocale] = useState<string>(LOCALE_DEFAULT);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const { urls: pastedUrls, invalid } = useMemo(() => parseUrls(text), [text]);
  const urls = tab === "paste" ? pastedUrls : crawlUrls;
  const canSubmit = urls.length > 0 && !isRunning;
  const canSaveSchedule = urls.length > 0 && !isRunning;

  // Resolved options for both submit and "Save as daily" (PSI ignores the
  // local-only levers — runs/throttling/warmCache are nominal defaults).
  const psiOptions = useMemo<AuditOptions>(
    () => ({
      formFactor: device === "both" ? "mobile" : device,
      throttling: "simulated",
      categories,
      runs: 1,
      warmCache: true,
      locale: locale === LOCALE_DEFAULT ? undefined : locale,
    }),
    [device, categories, locale],
  );

  const scheduleTarget = useMemo<ScheduleTarget>(
    () => ({ kind: "urls", urls }),
    [urls],
  );

  const handleCrawlUrlsChange = useCallback((next: string[]) => {
    setCrawlUrls(next);
  }, []);

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

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit({ urls, device, source: "psi", options: psiOptions });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="px-4">
          <div className="grid gap-0 min-[1440px]:grid-cols-2">
            {/* Targets */}
            <section
              aria-labelledby="psi-targets-heading"
              className="@container flex flex-col gap-4 pb-6 min-[1440px]:pb-0 min-[1440px]:pr-6"
            >
              <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2
                  id="psi-targets-heading"
                  className="font-heading text-base font-medium leading-snug"
                >
                  Target URLs
                </h2>
                <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
                  Audited by Google · one URL per line
                </p>
              </header>
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
            </section>

            {/* Config */}
            <section
              aria-labelledby="psi-config-heading"
              className="@container flex flex-col gap-4 border-t border-border/60 pt-6 min-[1440px]:border-t-0 min-[1440px]:border-l min-[1440px]:pl-6 min-[1440px]:pt-0"
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

              <div className="grid grid-cols-1 gap-x-5 gap-y-4 @md:grid-cols-2">
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
              </div>

              <Separator />

              <div className="flex flex-col gap-4 @2xl:flex-row @2xl:items-end @2xl:justify-between">
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

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setScheduleOpen(true)}
                  disabled={!canSaveSchedule}
                  className="shrink-0"
                  title={
                    canSaveSchedule
                      ? "Save these URLs + options as a daily PageSpeed schedule"
                      : "Add at least one URL before saving as daily"
                  }
                >
                  <CalendarPlus data-icon="inline-start" />
                  Save as daily
                </Button>
              </div>

              <Alert>
                <Info />
                <AlertDescription>
                  PageSpeed Insights runs Lighthouse on Google&apos;s servers with
                  fixed lab settings (mobile emulates a mid-tier phone on slow 4G).
                  Real-world Core Web Vitals from the Chrome UX Report are included
                  when a URL has enough traffic.
                </AlertDescription>
              </Alert>
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

      {results}

      <SaveScheduleDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        target={scheduleTarget}
        options={psiOptions}
        concurrency={3}
        device={device}
        accuracyMode={false}
        source="psi"
      />
    </div>
  );
}
