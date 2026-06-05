"use client";

/**
 * Full-width "Discovered pages" table — the curation surface of the workspace
 * (PRD: discovered pages now live under the input card, not inside the cramped
 * Crawl tab). Rendered by {@link WorkspacePanel} in its `discovered` state.
 *
 * One row per discovered URL across the full page width: a selection checkbox,
 * the URL (mono, struck-through when deselected), its discovery source + depth,
 * and a remove action. The selection state itself is owned upstream by
 * `NewAuditForm` and threaded down as a single {@link DiscoverySelection} object
 * (avoids prop sprawl); this component is otherwise presentational.
 *
 * Visual shell mirrors the results table (`results-table.tsx`) — `Card` +
 * sticky mono header + hairline rows — so the swap to live results reads as the
 * same instrument changing its readout.
 */

import { CircleSlash, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DiscoverResult } from "@/lib/crawl/types";
import { cn } from "@/lib/utils";

/** Shared header label styling — matches the results table for visual parity. */
const HEAD_LABEL = "font-mono text-[0.7rem] uppercase tracking-[0.16em]";

/**
 * The lifted crawl selection: the discovery result plus the selection set and its
 * mutators. Owned by `NewAuditForm`; consumed by the workspace's discovered view
 * (this table) and the workspace header's count + select-all control.
 */
export interface DiscoverySelection {
  result: DiscoverResult;
  selected: ReadonlySet<string>;
  toggleOne: (url: string) => void;
  toggleAll: () => void;
  removeOne: (url: string) => void;
}

interface DiscoveredUrlsPanelProps {
  selection: DiscoverySelection;
  /** Locks the row controls while a batch from this form is running. */
  disabled?: boolean;
}

export function DiscoveredUrlsPanel({
  selection,
  disabled = false,
}: DiscoveredUrlsPanelProps) {
  const { result, selected, toggleOne, removeOne } = selection;

  // Empty discovery (valid origin, zero URLs): keep the dashed guidance card the
  // crawl tab used to show, now full-width inside the workspace.
  if (result.urls.length === 0) {
    return (
      <div className="flex flex-col items-start gap-1 rounded-lg border border-dashed border-border/70 bg-muted/20 p-8">
        <CircleSlash className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">No URLs to preview</p>
        <p className="text-sm text-muted-foreground">
          Try a different seed, raise the depth, or enable both discovery sources.
        </p>
      </div>
    );
  }

  return (
    <Card className="overflow-hidden py-0">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10">
              <span className="sr-only">Selected</span>
            </TableHead>
            <TableHead className={cn(HEAD_LABEL, "w-full")}>URL</TableHead>
            <TableHead className={HEAD_LABEL}>Source</TableHead>
            <TableHead className={cn(HEAD_LABEL, "text-right")}>Depth</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">Remove</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.urls.map((item) => {
            const isChecked = selected.has(item.url);
            return (
              <TableRow key={item.url} className="hover:bg-muted/40">
                <TableCell>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isChecked}
                    aria-label={`${isChecked ? "Deselect" : "Select"} ${item.url}`}
                    onClick={() => toggleOne(item.url)}
                    disabled={disabled}
                    className={cn(
                      "flex items-center justify-center rounded-sm outline-none",
                      "focus-visible:ring-3 focus-visible:ring-ring/50",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                        isChecked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input bg-transparent",
                      )}
                    >
                      {isChecked ? (
                        <svg viewBox="0 0 16 16" fill="none" className="size-3">
                          <path
                            d="M3.5 8.5l3 3 6-6.5"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : null}
                    </span>
                  </button>
                </TableCell>
                <TableCell className="max-w-0">
                  <span
                    title={item.url}
                    className={cn(
                      "block truncate font-mono text-xs tabular-nums",
                      isChecked
                        ? "text-foreground"
                        : "text-muted-foreground line-through decoration-border",
                    )}
                  >
                    {item.url.replace(/^https?:\/\//, "")}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={item.source === "sitemap" ? "secondary" : "outline"}
                    className="font-mono text-[0.6rem] uppercase tracking-[0.12em]"
                  >
                    {item.source}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {item.depth != null ? `d${item.depth}` : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeOne(item.url)}
                    disabled={disabled}
                    aria-label={`Remove ${item.url}`}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
