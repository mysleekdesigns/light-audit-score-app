"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { DOCS_SECTION_IDS } from "@/components/docs/sections";

/** O(1) "is this hash one of ours?" for the page-wide anchor handler. */
const SECTION_IDS = new Set(DOCS_SECTION_IDS);

/* ----------------------------------------------------------- breakpoint ---- */

/**
 * The complement of Tailwind's `xl` (80rem), so this query and every `max-xl:`
 * class below flip at exactly the same width. Written as `not all and …`
 * rather than range syntax because the two must never disagree by a pixel:
 * one decides the markup, the other decides what is visible.
 */
const COLLAPSED_QUERY = "not all and (min-width: 80rem)";

// One MediaQueryList for the whole manual — twenty chapters subscribing to
// twenty separate lists would be twenty listeners for one boolean.
let collapsedQuery: MediaQueryList | null = null;
function getCollapsedQuery(): MediaQueryList {
  return (collapsedQuery ??= window.matchMedia(COLLAPSED_QUERY));
}

function subscribeCollapsed(onChange: () => void): () => void {
  const query = getCollapsedQuery();
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getCollapsed(): boolean {
  return getCollapsedQuery().matches;
}

/**
 * The server has no viewport, so it renders the narrow shape: heading buttons,
 * and every chapter but the first carrying `max-xl:hidden`. That is also what
 * the CSS does on its own, which is the point — a wide browser shows the whole
 * manual from the first paint, before this island has hydrated, and hydration
 * only takes the now-pointless buttons back out again.
 */
function getCollapsedOnServer(): boolean {
  return true;
}

/* -------------------------------------------------------------- context ---- */

interface DocsChapterState {
  /** The chapter expanded below `xl`. `""` when the reader has closed all of them. */
  openId: string;
  /** Whether the viewport is narrow enough for the accordion to be in charge. */
  collapsed: boolean;
  setOpenId: React.Dispatch<React.SetStateAction<string>>;
}

const DocsChapterContext = createContext<DocsChapterState | null>(null);

/**
 * Turns the manual into a single-open accordion below `xl`.
 *
 * Below the breakpoint there is no room for the contents rail beside the text,
 * and twenty full chapters stacked end to end is a very long scroll to reach
 * chapter twenty. So the chapters collapse to a numbered index and exactly one
 * opens at a time — the first, until the reader picks another. From `xl` up the
 * rail returns and the manual reads straight through, exactly as before.
 *
 * Which chapter is open lives here rather than in each chapter so that opening
 * one closes the last without the two having to know about each other. The
 * chapters themselves stay server components: only this shell and the heading
 * button ship as JavaScript, and the prose arrives as prerendered children.
 */
export function DocsChapters({ children }: { children: React.ReactNode }) {
  const [openId, setOpenId] = useState<string>(DOCS_SECTION_IDS[0]);
  const collapsed = useSyncExternalStore(subscribeCollapsed, getCollapsed, getCollapsedOnServer);

  useEffect(() => {
    const openFromHash = () => {
      const id = window.location.hash.slice(1);
      if (!SECTION_IDS.has(id)) return;
      flushSync(() => setOpenId(id));
      // The browser scrolled to this chapter while it was still collapsed —
      // on a first load that is before this island even exists, and the
      // chapter that was open until now has just closed above it. Land on it
      // again now that the page is the shape the reader asked for.
      // `block: "start"` honours the page's `scroll-padding-top`.
      document.getElementById(id)?.scrollIntoView({ behavior: "auto", block: "start" });
    };

    // A link into a collapsed chapter has to open it, or it lands the reader on
    // a heading with nothing under it. This is one listener above the whole page
    // rather than a handler on each of the manual's several dozen cross
    // references — and it catches the contents rail and the entry cards too.
    const openFromClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return; // Opening in a new tab shouldn't reshuffle this one.
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const href = target.closest("a[href]")?.getAttribute("href");
      if (href === undefined || href === null || !href.startsWith("#")) return;
      const id = href.slice(1);
      if (!SECTION_IDS.has(id)) return;
      // Synchronously, in the capture phase: the scroll that follows — the
      // browser's own, or the contents rail's `scrollIntoView` on the way back
      // up the tree — then measures a page where the chapter is already open
      // and whichever one was open above it has already closed.
      flushSync(() => setOpenId(id));
    };

    // Deep link, or a reload with a hash already in the bar. Deferred by a
    // turn: `flushSync` is refused while React is still committing this effect,
    // and without it the correction below would measure the old layout.
    queueMicrotask(openFromHash);
    document.addEventListener("click", openFromClick, true);
    window.addEventListener("hashchange", openFromHash);
    return () => {
      document.removeEventListener("click", openFromClick, true);
      window.removeEventListener("hashchange", openFromHash);
    };
  }, []);

  const value = useMemo<DocsChapterState>(
    () => ({ openId, collapsed, setOpenId }),
    [openId, collapsed],
  );

  return <DocsChapterContext.Provider value={value}>{children}</DocsChapterContext.Provider>;
}

/* -------------------------------------------------------------- chapter ---- */

export interface DocsChapterProps {
  /** Anchor id — must match the `id` in `DOCS_SECTIONS` so the TOC can find it. */
  id: string;
  /** Monospace plate number, e.g. "03". */
  index: string;
  title: string;
  /** One-line summary under the heading. */
  lede?: string;
  children: React.ReactNode;
}

/**
 * One numbered chapter — a heading plate, and the chapter body it discloses.
 *
 * Two shapes from one set of elements. Wide: the plate sits above the title,
 * the body is always open, and the title carries the `#` self-link that makes
 * every chapter addressable. Narrow: plate, title and chevron line up as one
 * row of an index, and the body is shown only for the open chapter.
 *
 * The button wraps the title text alone — a heading is flow content and cannot
 * live inside a button — and stretches over the whole row with a pseudo-element
 * so the plate and the chevron are part of the target rather than dead space
 * beside it. Above `xl` the button is gone entirely: a control that cannot
 * collapse anything has no business being announced as one.
 */
export function DocsChapter({ id, index, title, lede, children }: DocsChapterProps) {
  const state = useContext(DocsChapterContext);
  const headerRef = useRef<HTMLDivElement | null>(null);

  // No provider means no accordion: every chapter reads as open.
  const open = state === null || state.openId === id;
  const disclosure = state !== null && state.collapsed;
  const panelId = `${id}-panel`;

  const setOpenId = state?.setOpenId;
  const toggle = useCallback(() => {
    if (!setOpenId) return;
    // Closing a chapter that sits above this one removes its height from the
    // page and drags the row the reader just tapped up the screen with it. Pin
    // the row instead: measure it, apply the change synchronously, and put back
    // however far it moved.
    const header = headerRef.current;
    const before = header?.getBoundingClientRect().top ?? 0;
    const next = open ? "" : id;
    flushSync(() => setOpenId(next));
    const after = header?.getBoundingClientRect().top ?? 0;
    if (after !== before) window.scrollBy(0, after - before);

    // Put the open chapter in the address bar so it can be copied and reloaded
    // — at this width the heading's own `#` link is not on screen to do it.
    // `replaceState`, like the contents rail: reading twenty chapters should
    // not leave twenty steps in the back button.
    const { pathname, search } = window.location;
    window.history.replaceState(null, "", next ? `#${next}` : `${pathname}${search}`);
  }, [id, open, setOpenId]);

  return (
    /* Narrow: a card per chapter, in the same hairline-on-tinted-glass the
       entry cards above the manual use, so a closed chapter reads as something
       to open. Wide: no card at all — just the hairline rule between chapters,
       because a stack of twenty framed panels is a filing cabinet, not a book. */
    <section
      id={id}
      className="group rounded-md border border-border/70 bg-card/50 xl:rounded-none xl:border-x-0 xl:border-b-0 xl:border-t xl:border-border/60 xl:bg-transparent xl:pt-8 xl:first:border-t-0 xl:first:pt-0"
    >
      <div
        ref={headerRef}
        className="group/head relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 rounded-md px-4 py-4 transition-colors touch-manipulation hover:bg-card motion-reduce:transition-none xl:flex xl:flex-col xl:gap-2.5 xl:rounded-none xl:px-0 xl:py-0 xl:hover:bg-transparent"
      >
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.32em] text-primary">
          {index}
        </span>
        <div className="flex items-baseline gap-3">
          <h2
            id={`${id}-heading`}
            /* Index-row scale while the chapters are an accordion: twenty
               display-sized headings stacked as a list read as twenty pages,
               not as one contents page. Full chapter scale from `xl`, where
               each heading opens a chapter that is actually below it. */
            className="text-pretty text-base font-semibold tracking-tight text-foreground xl:text-[1.75rem]"
          >
            {disclosure ? (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={toggle}
                className="cursor-pointer text-left transition-colors before:absolute before:inset-0 before:rounded-md before:content-[''] hover:text-primary focus-visible:outline-none focus-visible:before:ring-2 focus-visible:before:ring-ring motion-reduce:transition-none xl:contents xl:before:hidden"
              >
                {title}
              </button>
            ) : (
              title
            )}
          </h2>
          {/* Reveals on hover/focus so the manual stays quiet at rest but every
              chapter is still linkable. Hidden where the row is a button, since
              a link inside the target would be a control inside a control. */}
          <a
            href={`#${id}`}
            aria-label={`Link to “${title}”`}
            className="hidden font-mono text-sm font-normal text-muted-foreground opacity-0 transition-opacity hover:text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 motion-reduce:transition-none xl:inline"
          >
            #
          </a>
        </div>
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 self-center text-muted-foreground transition-[transform,color] group-hover/head:text-foreground motion-reduce:transition-none xl:hidden",
            open && "rotate-180",
          )}
        />
      </div>

      {/* Visibility is a class rather than the `hidden` attribute so it answers
          to the breakpoint, not to hydration: a wide viewport shows every
          chapter from the first paint, and dragging the window across 1280px
          collapses or reopens them with no JavaScript involved. */}
      <div
        id={panelId}
        className={cn(
          lede ? "mt-2.5" : undefined,
          "px-4 pb-5 xl:px-0 xl:pb-0",
          !open && "max-xl:hidden",
        )}
      >
        {lede ? (
          <p className="text-pretty text-[0.95rem] leading-relaxed text-muted-foreground">{lede}</p>
        ) : null}
        <div className="mt-6 flex flex-col gap-5">{children}</div>
      </div>
    </section>
  );
}
