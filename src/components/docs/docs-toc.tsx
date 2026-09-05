"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { DOCS_GROUPS, DOCS_SECTION_IDS, docsPlate } from "@/components/docs/sections";

/** The grouped entries of the rail. */
function TocList({
  active,
  onNavigate,
}: {
  active: string;
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>, id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      {DOCS_GROUPS.map((group) => (
        <div key={group.title} className="flex flex-col gap-1.5">
          <span className="px-3 font-mono text-[0.62rem] uppercase tracking-[0.24em] text-muted-foreground">
            {group.title}
          </span>
          {/* `role="list"` because `list-style: none` strips list semantics in
              Safari/VoiceOver, taking the "N items" count with it. */}
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
 * The manual's contents: a sticky rail beside the chapters that highlights
 * whichever one you are reading.
 *
 * `xl` and up only. Below that the chapters collapse into a single-open
 * accordion (`DocsChapters`), whose numbered rows are already the contents
 * list — a second one above them would be the same twenty entries twice.
 *
 * The entries are ordinary `<a href="#id">`, so each one is copyable as a URL
 * and works before this island hydrates; the handler only upgrades what the
 * browser already does with a smooth scroll and a `replaceState`, so following
 * twenty entries doesn't bury the back button.
 */
export function DocsToc() {
  const [active, setActive] = useState<string>(DOCS_SECTION_IDS[0]);
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
      className="hidden xl:sticky xl:top-24 xl:flex xl:max-h-[calc(100vh-8rem)] xl:flex-col xl:gap-6 xl:overflow-y-auto xl:overscroll-contain"
    >
      <span className="font-mono text-[0.65rem] uppercase tracking-[0.28em] text-muted-foreground">
        Contents
      </span>
      <TocList active={active} onNavigate={handleClick} />
    </nav>
  );
}
