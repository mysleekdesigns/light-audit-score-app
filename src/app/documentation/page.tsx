import type { Metadata } from "next";
import Link from "next/link";
import { Compass, Cpu, Gauge } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { DocsToc } from "@/components/docs/docs-toc";
import { StartChapters } from "@/components/docs/chapters/start-chapters";
import { AuditingChapters } from "@/components/docs/chapters/auditing-chapters";
import { AiChapters } from "@/components/docs/chapters/ai-chapters";
import { ResultsChapters } from "@/components/docs/chapters/results-chapters";
import { ReferenceChapters } from "@/components/docs/chapters/reference-chapters";
import { DOCS_SECTIONS } from "@/components/docs/sections";

export const metadata: Metadata = {
  title: "Documentation — LightAudit Score",
  description:
    "How to use LightAudit Score: running audits, reading the scores, AI analysis with Claude or a local Ollama model, schedules, and where your data lives.",
};

/** The three things a first-time reader most often wants to do. */
const ENTRY_POINTS = [
  {
    href: "#first-audit",
    icon: Compass,
    kicker: "New here",
    title: "Your first audit",
    detail: "Paste one address, press one button, read the result. About a minute.",
  },
  {
    href: "#ai-providers",
    icon: Cpu,
    kicker: "AI analysis",
    title: "Claude or Ollama",
    detail: "Switch which AI explains your scores by clicking a button in Settings.",
  },
  {
    href: "#accuracy",
    icon: Gauge,
    kicker: "Accuracy",
    title: "Trustworthy numbers",
    detail: "Why a fast laptop flatters a page, and the one button that fixes it.",
  },
] as const;

/**
 * The user manual.
 *
 * Static by construction: every chapter is a server component and the route is
 * prerendered at build time, so the manual is plain HTML a reader can search
 * with the browser's own find and deep-link into. The only client code is the
 * contents rail, which needs an observer to know which chapter you are in — and
 * even that leans on a native `<details>` so the entries are reachable before it
 * hydrates.
 *
 * Chapters run the full width of their column at every breakpoint rather than
 * sitting in a capped measure, matching the full-bleed density the rest of the
 * app uses to reclaim wide screens.
 */
export default function DocumentationPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="07 — Manual"
        title="Documentation"
        description="Everything LightAudit Score does, written for someone who has never run a Lighthouse audit before. Start at the top, or jump to what you need."
      >
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-muted-foreground">
          {DOCS_SECTIONS.length} chapters
        </span>
      </PageHeader>

      {/* Three doors in, for the reader who arrived with a specific question and
          would otherwise have to parse a twenty-item contents list first. */}
      <ul role="list" className="grid list-none gap-3 p-0 sm:grid-cols-3">
        {ENTRY_POINTS.map(({ href, icon: Icon, kicker, title, detail }) => (
          <li key={href} className="min-w-0">
            <Link
              href={href}
              className="group flex h-full flex-col gap-2 rounded-md border border-border/70 bg-card/50 p-4 transition-colors hover:border-primary/40 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-2 font-mono text-[0.62rem] uppercase tracking-[0.24em] text-primary">
                <Icon className="size-3.5" aria-hidden />
                {kicker}
              </span>
              <span className="text-[0.95rem] font-medium text-foreground">{title}</span>
              <span className="text-[0.85rem] leading-relaxed text-muted-foreground">{detail}</span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="grid gap-8 xl:grid-cols-[15rem_minmax(0,1fr)] xl:gap-12">
        <DocsToc />

        {/* `min-w-0` so a wide code block scrolls inside its own frame rather
            than stretching the grid column and the whole page with it. */}
        <div className="flex min-w-0 flex-col gap-10">
          <StartChapters />
          <AuditingChapters />
          <AiChapters />
          <ResultsChapters />
          <ReferenceChapters />

          <footer className="border-t border-border/60 pt-6">
            <p className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-muted-foreground">
              End of manual · Lighthouse v13 · local lab data
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}
