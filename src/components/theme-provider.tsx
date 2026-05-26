"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * App theme. This is a single-user local instrument — dark only.
 * `forcedTheme` pins `.dark` on <html> deterministically (no flash, no toggle),
 * while still feeding the resolved theme to components that read it (e.g. sonner).
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      forcedTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
