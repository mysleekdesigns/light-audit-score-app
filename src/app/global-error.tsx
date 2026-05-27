"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

import "./globals.css";

// Top-level error boundary. Replaces the entire document when the root layout
// itself throws, so it must render its own <html>/<body> and cannot rely on
// providers, fonts, or shared chrome. Kept minimal but on-brand: forces the
// dark precision-instrument palette via the `dark` class.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Global error boundary caught:", error);
  }, [error]);

  return (
    <html lang="en" className="dark antialiased" style={{ colorScheme: "dark" }}>
      <body className="min-h-dvh bg-background text-foreground">
        <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-center justify-center gap-6 px-6 py-16 text-center">
          <span className="font-mono text-xs uppercase tracking-[0.32em] text-score-poor">
            Fatal — console offline
          </span>

          <div className="flex size-12 items-center justify-center rounded-lg bg-muted text-score-poor">
            <AlertTriangle aria-hidden="true" className="size-6" />
          </div>

          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              The console crashed
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              A fatal error stopped the application from loading. Reloading
              usually clears it — your saved runs on disk are unaffected.
            </p>
            {error.digest ? (
              <p className="mt-1 font-mono text-[0.7rem] uppercase tracking-[0.18em] text-muted-foreground">
                Ref {error.digest}
              </p>
            ) : null}
          </div>

          <button
            type="button"
            onClick={reset}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors outline-none hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
