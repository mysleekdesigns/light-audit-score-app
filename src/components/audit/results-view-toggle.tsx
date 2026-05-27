"use client";

/**
 * Results view toggle (PRD §6 Phase 11) — a compact segmented control that flips
 * a results surface between the dense `table` and the ring-`card` grid. Shared by
 * the live results panel and the History archive so the affordance is identical
 * in both places; the chosen value is persisted by the caller via
 * {@link useAuditDefaults} (`defaults.resultsView`). Pure presentational.
 */

import { LayoutGrid, Table2 } from "lucide-react";

import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import type { ResultsView } from "@/lib/settings/defaults";
import { cn } from "@/lib/utils";

export interface ResultsViewToggleProps {
  value: ResultsView;
  onChange: (next: ResultsView) => void;
  className?: string;
}

export function ResultsViewToggle({
  value,
  onChange,
  className,
}: ResultsViewToggleProps) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      onValueChange={(next) => {
        // Radix emits "" when the active item is re-pressed; ignore that so a
        // view is always selected.
        if (next === "table" || next === "cards") onChange(next);
      }}
      aria-label="Results layout"
      className={cn(className)}
    >
      <ToggleGroupItem
        value="table"
        aria-label="Dense table"
        className="font-mono text-[0.65rem] uppercase tracking-[0.16em]"
      >
        <Table2 data-icon="inline-start" />
        Table
      </ToggleGroupItem>
      <ToggleGroupItem
        value="cards"
        aria-label="Ring cards"
        className="font-mono text-[0.65rem] uppercase tracking-[0.16em]"
      >
        <LayoutGrid data-icon="inline-start" />
        Cards
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
