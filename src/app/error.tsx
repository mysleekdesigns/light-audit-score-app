"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, Home, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

// Route-level error boundary. Catches render/runtime errors below the root
// layout and offers a calm recovery surface rather than a stack trace.
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the real error to the developer console without exposing it
    // to the user.
    console.error("Route error boundary caught:", error);
  }, [error]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2 border-b border-border/60 pb-6">
        <span className="font-mono text-xs uppercase tracking-[0.32em] text-score-poor">
          Fault — instrument halted
        </span>
      </div>

      <Empty className="border border-border/60 bg-card/40 py-14">
        <EmptyHeader>
          <EmptyMedia
            variant="icon"
            className="size-10 text-score-poor [&_svg:not([class*='size-'])]:size-5"
          >
            <AlertTriangle aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Something went sideways</EmptyTitle>
          <EmptyDescription>
            This panel hit an unexpected error and couldn&apos;t finish
            rendering. Your saved runs are untouched — try the action again, or
            head back to a clean console.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {error.digest ? (
            <p className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-muted-foreground">
              Ref {error.digest}
            </p>
          ) : null}
          <div className="flex items-center gap-3">
            <Button onClick={reset}>
              <RotateCcw aria-hidden="true" />
              Try again
            </Button>
            <Button variant="outline" asChild>
              <Link href="/">
                <Home aria-hidden="true" />
                New Audit
              </Link>
            </Button>
          </div>
        </EmptyContent>
      </Empty>
    </div>
  );
}
