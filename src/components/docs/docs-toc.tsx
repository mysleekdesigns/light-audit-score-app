"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { DOCS_GROUPS, DOCS_SECTION_IDS, docsPlate } from "@/components/docs/sections";

/** The grouped entries, shared by the drawer and the rail so they cannot drift. */
function TocList({
  active,
  onNavigate,
  className,
}: {
  active: string;
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>, id: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {DOCS_GROUPS.map((group) => (
        <div key={group.title} className="flex flex-col gap-1.5">
          <span className="px-3 font-mono text-[0.62rem] uppercase tracking-[0.24em] text-muted-foreground">
            {group.title}
          </span>
          {/* `role="list"` because `list-style: none` strips list semantics in
              Safari/VoiceOver, taking the "20 items" count with it. */}
          <ul role="list" className="flex list-none flex-col p-0">
            {group.sections.map((section) => {
              const current = active === section.id;
              return (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    onClick={(e) => onNavigate(e, section.id)}
                    aria-current={current ? "location" : undefined}
                    className={cn(
                      "group/toc relative flex items-baseline gap-2.5 rounded-sm py-1.5 pl-3 pr-2 text-[0.82rem] leading-snug transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      current ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {/* Reading marker: a hairline that fills in on the current
                        chapter. Paired with the weight change and `aria-current`
                        below, so the rail never relies on colour alone. */}
                    <span
                      aria-hidden
                      className={cn(
                        "absolute inset-y-1 left-0 w-px transition-colors",
                        current ? "bg-primary" : "bg-border group-hover/toc:bg-muted-foreground/50",
                      )}
                    />
                    <span
                      className={cn(
                        "font-mono text-[0.62rem] tabular-nums transition-colors",
                        current ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {docsPlate(section.id)}
                    </span>
                    <span className={cn(current && "font-medium")}>{section.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * The manual's contents.
 *
 * Two presentations, one landmark. From `xl` up it is a sticky rail beside the
 * chapters that highlights whichever chapter you are reading; below `xl` — where
 * there is no room beside the text — it is a disclosure above the manual. Both
 * live inside the single `<nav>`, so there is never a second "On this page"
 * landmark competing with the first, and only one is ever displayed.
 *
 * The disclosure is a native `<details>` rather than a React-controlled panel:
 * it opens and closes from the browser's own semantics, so it works the moment
 * the HTML is parsed rather than once this island hydrates, brings its own
 * expanded state and keyboard behaviour, and — because toggling `open` is a
 * synchronous DOM mutation — lets the click handler measure the collapsed
 * layout without waiting on a render. The entries are ordinary `<a href="#id">`,
 * so each one is copyable as a URL; the handler only upgrades what the browser
 * already does with a smooth scroll and a `replaceState`, so following twenty
 * entries doesn't bury the back button.
 */
export function DocsToc() {
  const [active, setActive] = useState<string>(DOCS_SECTION_IDS[0]);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  // Which section ids are currently in the reading band.
  const visible = useRef<Set<string>>(new Set());

  useEffect(() => {
    const sections = DOCS_SECTION_IDS.map((id) => document.getElementById(id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.current.add(entry.target.id);
          else visible.current.delete(entry.target.id);
        }
        // The topmost chapter inside the band wins.
        const first = DOCS_SECTION_IDS.find((id) => visible.current.has(id));
        if (first) {
          setActive(first);
          return;
        }
        // Nothing in the band means one of two things. Either the page header is
        // still on screen, in which case the first chapter is the one being read
        // towards — otherwise scrolling back to the top would leave whichever
        // chapter you came from highlighted. Or we are parked mid-chapter in a
        // long one, where the previous choice is still right and stands.
        const opening = document.getElementById(DOCS_SECTION_IDS[0]);
        if (opening && opening.getBoundingClientRect().top > 0) setActive(DOCS_SECTION_IDS[0]);
      },
      {
        // Top edge below the sticky header; bottom edge two-thirds up the
        // viewport, so a heading becomes "current" as it reaches reading height
        // rather than when it first peeks in from the bottom.
        rootMargin: "-88px 0px -66% 0px",
        threshold: 0,
      },
    );

    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, []);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, id: string) => {
      const target = document.getElementById(id);
      if (!target) return; // Let the browser's own anchor handling take over.
      event.preventDefault();
      window.history.replaceState(null, "", `#${id}`);
      setActive(id);

      // Closing the drawer removes a tall block from above the chapters, so it
      // has to happen before the scroll is measured or the jump lands short.
      // Toggling `open` on the native element is a synchronous DOM mutation, so
      // the layout `scrollIntoView` reads below is already the collapsed one —
      // no frame callback to wait on, and nothing that stalls in a hidden tab.
      if (detailsRef.current) detailsRef.current.open = false;

      // Move focus with the scroll so keyboard and screen-reader users land in
      // the chapter they picked, not back at the contents. Deferred until the
      // scroll is under way, since focusing mid-animation cancels it in some
      // browsers.
      const land = () => {
        target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      };

      // `block: "start"` honours the page's `scroll-padding-top`, so the heading
      // clears the sticky header without repeating that offset here.
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        target.scrollIntoView({ behavior: "auto", block: "start" });
        land();
        return;
      }

      const startY = window.scrollY;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      // Smooth scrolling is not always available — Chrome can have it turned off
      // by flag or platform setting, and then every smooth scroll is a silent
      // no-op. Check that we actually moved and land it instantly if not: an
      // abrupt jump is a far better failure than no jump at all.
      window.setTimeout(() => {
        if (Math.abs(window.scrollY - startY) < 4) {
          target.scrollIntoView({ behavior: "auto", block: "start" });
        }
        land();
      }, 120);
    },
    [],
  );

  return (
    <nav
      aria-label="On this page"
      className="xl:sticky xl:top-24 xl:max-h-[calc(100vh-8rem)] xl:overflow-y-auto xl:overscroll-contain"
    >
      {/* Below `xl`, where the rail can't sit beside the text. `<summary>`
          carries its own expanded state, keyboard behaviour and no-JS toggle. */}
      <details
        ref={detailsRef}
        className="group rounded-md border border-border/70 bg-card/40 xl:hidden"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-4 py-3 font-mono text-xs uppercase tracking-[0.18em] text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-open:border-b group-open:border-border/60 group-open:rounded-b-none [&::-webkit-details-marker]:hidden">
          Contents
          <ChevronDown
            aria-hidden
            className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
          />
        </summary>
        <TocList active={active} onNavigate={handleClick} className="p-4" />
      </details>

      {/* From `xl` up: the always-open rail. */}
      <div className="hidden xl:flex xl:flex-col xl:gap-6">
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.28em] text-muted-foreground">
          Contents
        </span>
        <TocList active={active} onNavigate={handleClick} />
      </div>
    </nav>
  );
}
