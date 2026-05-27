import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { SiteHeader } from "@/components/site-header";

// UI / headings: a technical grotesque with engineered character.
const archivo = Archivo({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

// Data accents: gauges, metrics, URLs, counters.
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Lighthouse — Local Audit Console",
  description:
    "A local instrument for measuring Lighthouse scores across one or many pages: median-of-N runs, bounded concurrency, persisted history.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${archivo.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <TooltipProvider>
            <SiteHeader />
            <main className="w-full flex-1 px-6 py-10 md:py-14 lg:px-10">
              {children}
            </main>
            <footer className="border-t border-border/60">
              <div className="flex w-full items-center justify-between px-6 py-4 font-mono text-[0.7rem] uppercase tracking-[0.18em] text-muted-foreground lg:px-10">
                <span>Local lab data · Lighthouse v13</span>
                <span className="text-muted-foreground/70">Median-of-N · bounded concurrency</span>
              </div>
            </footer>
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
