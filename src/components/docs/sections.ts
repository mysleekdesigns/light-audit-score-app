/**
 * The manual's table of contents — the single source of truth shared by the
 * sidebar and the chapters themselves.
 *
 * The page renders `DocsSection`s with these exact ids and plate numbers, so a
 * chapter can never drift out of the contents list (or be numbered twice). Kept
 * as a plain module with no React imports so both a server chapter and the
 * client-side sidebar can read it.
 */

export interface DocsSectionMeta {
  /** Anchor id — matches the `id` passed to `DocsSection`. */
  id: string;
  /** Sidebar label. Short; the chapter heading may be longer. */
  label: string;
}

export interface DocsGroupMeta {
  /** Monospace group heading in the sidebar. */
  title: string;
  sections: readonly DocsSectionMeta[];
}

export const DOCS_GROUPS: readonly DocsGroupMeta[] = [
  {
    title: "Start here",
    sections: [
      { id: "orientation", label: "What this app does" },
      { id: "install", label: "Set up and start" },
      { id: "first-audit", label: "Your first audit" },
      { id: "reading-scores", label: "Reading the scores" },
    ],
  },
  {
    title: "Auditing",
    sections: [
      { id: "audit-settings", label: "Audit settings" },
      { id: "accuracy", label: "Trustworthy numbers" },
      { id: "discovery", label: "Finding pages" },
      { id: "pagespeed", label: "PageSpeed Insights" },
    ],
  },
  {
    title: "AI analysis",
    sections: [
      { id: "ai-analysis", label: "Ask why a score is low" },
      { id: "ai-providers", label: "Claude, Ollama, or your own" },
      { id: "web-research", label: "Give the AI the web" },
    ],
  },
  {
    title: "Working with results",
    sections: [
      { id: "history", label: "History" },
      { id: "compare", label: "Compare & trends" },
      { id: "batches", label: "Batches & thresholds" },
      { id: "schedule", label: "Scheduled audits" },
    ],
  },
  {
    title: "Reference",
    sections: [
      { id: "settings", label: "Settings" },
      { id: "data", label: "Where your data lives" },
      { id: "privacy", label: "Privacy & the local server" },
      { id: "troubleshooting", label: "Troubleshooting" },
      { id: "faq", label: "Questions" },
    ],
  },
] as const;

/** Every section in reading order, flattened. */
export const DOCS_SECTIONS: readonly DocsSectionMeta[] = DOCS_GROUPS.flatMap(
  (group) => group.sections,
);

/** Ordered anchor ids — what the sidebar observes for the active chapter. */
export const DOCS_SECTION_IDS: readonly string[] = DOCS_SECTIONS.map((s) => s.id);

/**
 * Zero-padded plate number for a chapter, e.g. `"07"`. Numbering is derived from
 * position rather than written down twice, so inserting a chapter renumbers the
 * rest automatically.
 */
export function docsPlate(id: string): string {
  const index = DOCS_SECTION_IDS.indexOf(id);
  return String(index + 1).padStart(2, "0");
}
