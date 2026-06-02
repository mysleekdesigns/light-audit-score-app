"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "New Audit", match: (p: string) => p === "/" },
  {
    href: "/pagespeed",
    label: "PageSpeed",
    match: (p: string) => p.startsWith("/pagespeed"),
  },
  {
    href: "/history",
    label: "History",
    match: (p: string) => p.startsWith("/history"),
  },
  {
    href: "/compare",
    label: "Compare",
    match: (p: string) => p.startsWith("/compare"),
  },
  {
    href: "/batches",
    label: "Batches",
    match: (p: string) => p.startsWith("/batches"),
  },
  {
    href: "/archive",
    label: "Archive",
    match: (p: string) => p.startsWith("/archive"),
  },
] as const;

/** Minimal lighthouse-beam mark: a focal point throwing a measured arc. */
function BeamMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="2.25" className="fill-current stroke-none" />
      <path d="M12 12 L23 6.5" />
      <path d="M12 12 L23 17.5" />
      <path d="M21.5 12 A 9.5 9.5 0 0 0 21.5 12" />
      <path d="M19.8 7 A 9 9 0 0 1 19.8 17" opacity="0.85" />
      <path d="M22.4 8.6 A 12 12 0 0 1 22.4 15.4" opacity="0.5" />
    </svg>
  );
}

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      {/* instrument accent line */}
      <div className="h-px w-full bg-gradient-to-r from-transparent via-primary/70 to-transparent" />
      <div className="flex h-16 w-full items-center gap-8 px-6 lg:px-10">
        <Link href="/" className="group flex items-center gap-3">
          <span className="text-primary transition-transform duration-300 group-hover:rotate-[8deg]">
            <BeamMark className="size-6" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="font-mono text-sm font-semibold uppercase tracking-[0.28em] text-foreground">
              Lighthouse
            </span>
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.3em] text-muted-foreground">
              Local Audit Console
            </span>
          </span>
        </Link>

        <nav className="flex items-center gap-1" aria-label="Primary">
          {NAV.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative px-3 py-2 font-mono text-xs uppercase tracking-[0.18em] transition-colors",
                  "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {item.label}
                <span
                  className={cn(
                    "absolute inset-x-2 -bottom-px h-px transition-colors",
                    active ? "bg-primary" : "bg-transparent"
                  )}
                />
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 rounded-full border border-border/70 bg-card/60 px-3 py-1.5">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-primary" />
          </span>
          <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
            Local · Node
          </span>
        </div>
      </div>
    </header>
  );
}
