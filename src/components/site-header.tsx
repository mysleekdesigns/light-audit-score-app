"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

const NAV = [
  { href: "/", label: "Lighthouse", match: (p: string) => p === "/" },
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
  {
    href: "/settings",
    label: "Settings",
    match: (p: string) => p.startsWith("/settings"),
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

/**
 * Drawer nav for widths below `lg`, where the seven inline destinations plus the
 * wordmark and status pill need ~990px and would otherwise push the whole page
 * into a horizontal scroll. Only rendered (and only reachable) below `lg`; from
 * `lg` up the trigger is `display: none`, so the inline `<nav>` is the single
 * visible Primary landmark at any one width.
 */
function MobileNav({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="Open navigation"
          className="-ml-1 shrink-0 touch-manipulation lg:hidden"
        >
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="w-[17rem] gap-0 overscroll-contain p-0"
      >
        <SheetHeader className="border-b border-border/60 p-4">
          <SheetTitle
            translate="no"
            className="font-mono text-sm font-semibold uppercase tracking-[0.28em]"
          >
            LightAudit
          </SheetTitle>
          <SheetDescription className="font-mono text-[0.6rem] uppercase tracking-[0.3em]">
            Lighthouse Audit Console
          </SheetDescription>
        </SheetHeader>
        {/* SheetClose closes the drawer as the link navigates, so the panel
            never lingers over the page it just routed to. */}
        <nav aria-label="Primary" className="flex flex-col gap-0.5 p-2">
          {NAV.map((item) => {
            const active = item.match(pathname);
            return (
              <SheetClose asChild key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative rounded-md px-3 py-2.5 font-mono text-xs uppercase tracking-[0.18em] transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {/* The active marker is a left rule here — an underline reads
                      as a divider once the links stack vertically. */}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-y-1.5 left-0 w-px",
                      active ? "bg-primary" : "bg-transparent",
                    )}
                  />
                  {item.label}
                </Link>
              </SheetClose>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      {/* instrument accent line */}
      <div className="h-px w-full bg-gradient-to-r from-transparent via-primary/70 to-transparent" />
      <div className="flex h-16 w-full items-center gap-4 px-6 lg:gap-8 lg:px-10">
        <MobileNav pathname={pathname} />

        <Link href="/" className="group flex min-w-0 items-center gap-3">
          <span className="shrink-0 text-primary transition-transform duration-300 group-hover:rotate-[8deg]">
            <BeamMark className="size-6" />
          </span>
          <span className="flex min-w-0 flex-col leading-none">
            <span
              translate="no"
              className="truncate font-mono text-sm font-semibold uppercase tracking-[0.28em] text-foreground"
            >
              LightAudit
            </span>
            {/* Wider than the wordmark it sits under, so it's the piece that
                decides the brand block's width — dropped in the band where the
                inline nav needs every pixel it can get. */}
            <span className="hidden font-mono text-[0.6rem] uppercase tracking-[0.3em] text-muted-foreground xl:inline">
              Lighthouse Audit Console
            </span>
          </span>
        </Link>

        <nav
          className="hidden items-center gap-0.5 lg:flex xl:gap-1"
          aria-label="Primary"
        >
          {NAV.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative px-2 py-2 font-mono text-xs uppercase tracking-[0.18em] transition-colors xl:px-3",
                  "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
                <span
                  className={cn(
                    "absolute inset-x-2 -bottom-px h-px transition-colors",
                    active ? "bg-primary" : "bg-transparent",
                  )}
                />
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2 rounded-full border border-border/70 bg-card/60 px-2 py-1.5 xl:px-3">
          <span className="relative flex size-2">
            {/* Indefinite loop — stilled for anyone who asked for less motion. */}
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2 rounded-full bg-primary" />
          </span>
          <span className="hidden font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground xl:inline">
            Local · Node
          </span>
        </div>
      </div>
    </header>
  );
}
