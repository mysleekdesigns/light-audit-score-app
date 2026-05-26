import { TriangleAlert, Play, ListPlus, Radar } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
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
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

const CATEGORIES = ["Performance", "Accessibility", "Best Practices", "SEO"];

export default function NewAuditPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="01 — Input"
        title="New Audit"
        description="Paste a list of URLs to measure their Lighthouse scores locally. Each page is audited in an isolated Chrome instance, median-of-N runs, with bounded concurrency for trustworthy numbers."
      />

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
            <Tabs defaultValue="paste" className="gap-4">
              <TabsList>
                <TabsTrigger value="paste">
                  <ListPlus data-icon="inline-start" />
                  Paste list
                </TabsTrigger>
                <TabsTrigger value="crawl">
                  <Radar data-icon="inline-start" />
                  Crawl site
                  <Badge variant="secondary" className="ml-1 font-mono text-[0.6rem]">
                    Phase 5
                  </Badge>
                </TabsTrigger>
              </TabsList>

              <TabsContent value="paste" className="flex flex-col gap-3">
                <Textarea
                  rows={10}
                  disabled
                  aria-label="Target URLs"
                  className="resize-none font-mono text-sm"
                  placeholder={
                    "https://example.com\nhttps://example.com/pricing\nhttps://example.com/blog"
                  }
                />
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  0 URLs queued
                </p>
              </TabsContent>

              <TabsContent value="crawl">
                <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border/70 bg-muted/20 p-6">
                  <Radar className="size-5 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">
                    Site discovery arrives in Phase 5
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Sitemap parsing + shallow same-origin crawl will populate this
                    list automatically.
                  </p>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* Run configuration */}
        <Card>
          <CardHeader>
            <CardTitle>Run config</CardTitle>
            <CardDescription>The biggest levers on score accuracy.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="device">Device</FieldLabel>
                <Select defaultValue="mobile" disabled>
                  <SelectTrigger id="device" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="mobile">Mobile</SelectItem>
                      <SelectItem value="desktop">Desktop</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="runs">Runs per URL</FieldLabel>
                <Select defaultValue="3" disabled>
                  <SelectTrigger id="runs" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {[1, 2, 3, 4, 5].map((n) => (
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
                <FieldLabel htmlFor="concurrency">Concurrency</FieldLabel>
                <Select defaultValue="3" disabled>
                  <SelectTrigger id="concurrency" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {[1, 2, 3, 4, 5, 6].map((n) => (
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
                <div className="flex flex-wrap gap-1.5">
                  {CATEGORIES.map((c) => (
                    <Badge key={c} variant="secondary" className="font-normal">
                      {c}
                    </Badge>
                  ))}
                </div>
              </FieldSet>

              <div className="flex items-start gap-2 rounded-md border border-score-average/40 bg-score-average/10 p-3">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-score-average" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  High concurrency causes CPU contention that distorts performance
                  scores. Keep it low for trustworthy numbers.
                </p>
              </div>
            </FieldGroup>
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-2">
            <Button disabled className="w-full">
              <Play data-icon="inline-start" />
              Run audit
            </Button>
            <p className="text-center font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
              Engine wiring → Phase 1–3
            </p>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
