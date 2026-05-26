import { Archive } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const COLUMNS = [
  "URL",
  "Device",
  "Perf",
  "A11y",
  "Best Pr.",
  "SEO",
  "Run at",
] as const;

export default function HistoryPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="02 — Archive"
        title="History"
        description="Every run is persisted to local SQLite and report files on disk, ready for before/after comparison."
      >
        <Badge variant="outline" className="font-mono text-xs">
          0 runs
        </Badge>
      </PageHeader>

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {COLUMNS.map((c) => (
                <TableHead
                  key={c}
                  className="font-mono text-[0.7rem] uppercase tracking-[0.16em]"
                >
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={COLUMNS.length} className="h-64 p-0">
                <div className="flex flex-col items-center justify-center gap-3 text-center">
                  <div className="flex size-12 items-center justify-center rounded-full border border-border/70 bg-muted/30">
                    <Archive className="size-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    No audits yet
                  </p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    Completed runs will appear here. Persistence and this archive
                    are wired up in Phase 4.
                  </p>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
