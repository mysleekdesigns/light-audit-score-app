"use client";

/**
 * The full-width workspace below the New Audit input card — one section that
 * morphs between two readouts so discovery and results share the same real
 * estate (PRD: "make use of the available space").
 *
 *  - `discovered` → the {@link DiscoveredUrlsPanel} curation table, with the
 *    selection count + select-all living in this shared title bar.
 *  - `results` → the live {@link AuditResults} node (passed in), which keeps its
 *    own telemetry strip + accordion.
 *  - `idle` → nothing (a clean page until the user discovers or runs).
 *
 * A persistent slim title bar is the constant that sells "the same section
 * updating": the heading flips `Discovered pages → Audit results` while the body
 * crossfades. The outer wrapper is a plain `<div>` (not a landmark) so it never
 * double-labels the `<section aria-label="Audit results">` AuditResults renders.
 */

import { type ReactNode } from "react";
import { SquareCheckBig, SquareDashed } from "lucide-react";

import {
  DiscoveredUrlsPanel,
  type DiscoverySelection,
} from "@/components/audit/discovered-urls-panel";
import { Button } from "@/components/ui/button";

export type WorkspaceView = "idle" | "discovered" | "results";

interface WorkspacePanelProps {
  view: WorkspaceView;
  /** Present (non-null) when `view === "discovered"`. */
  selection: DiscoverySelection | null;
  /** The `<AuditResults/>` node, rendered when `view === "results"`. */
  results: ReactNode;
  /** Locks the discovered-list controls while a batch from this form is running. */
  disabled?: boolean;
}

export function WorkspacePanel({
  view,
  selection,
  results,
  disabled = false,
}: WorkspacePanelProps) {
  if (view === "idle") return null;

  const discovered = view === "discovered" && selection != null;
  const title = discovered ? "Discovered pages" : "Audit results";

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <h2 className="font-heading text-base font-medium leading-snug">
          {title}
        </h2>
        {discovered && selection ? (
          <DiscoveredReadout selection={selection} disabled={disabled} />
        ) : null}
      </header>

      {/* Keyed so the body crossfades when the workspace flips state. Restrained,
          and gated on motion-safe so reduced-motion users get an instant swap. */}
      <div
        key={view}
        className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
      >
        {discovered && selection ? (
          <DiscoveredUrlsPanel selection={selection} disabled={disabled} />
        ) : (
          results
        )}
      </div>
    </div>
  );
}

/** The discovered title-bar readout: origin · selected count + a select-all toggle. */
function DiscoveredReadout({
  selection,
  disabled,
}: {
  selection: DiscoverySelection;
  disabled: boolean;
}) {
  const { result, selected, toggleAll } = selection;
  const total = result.urls.length;
  const selectedCount = result.urls.reduce(
    (n, u) => (selected.has(u.url) ? n + 1 : n),
    0,
  );
  const allSelected = total > 0 && selectedCount === total;

  return (
    <div className="flex items-center gap-3">
      <p
        aria-live="polite"
        className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground"
      >
        <span className="text-muted-foreground/70">
          {result.origin.replace(/^https?:\/\//, "")}
        </span>
        {" · "}
        <span className="text-foreground tabular-nums">{selectedCount}</span> of{" "}
        <span className="tabular-nums">{total}</span> selected
      </p>
      {total > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={toggleAll}
          disabled={disabled}
          className="font-mono text-[0.65rem] uppercase tracking-[0.18em]"
        >
          {allSelected ? (
            <>
              <SquareDashed data-icon="inline-start" />
              Deselect all
            </>
          ) : (
            <>
              <SquareCheckBig data-icon="inline-start" />
              Select all
            </>
          )}
        </Button>
      ) : null}
    </div>
  );
}
