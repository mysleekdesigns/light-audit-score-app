/**
 * The typed failure every analysis driver throws and the analyze route maps to a
 * terminal `error` SSE frame.
 *
 * It lives in its own module so drivers can throw it without importing the
 * engine that orchestrates them (which imports the drivers) — no import cycle.
 */

import type { AnalysisErrorCode } from "@/lib/analysis/types";

/** Typed failure surfaced to the route (mapped to an `error` SSE frame). */
export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode;
  constructor(code: AnalysisErrorCode, message: string) {
    super(message);
    this.name = "AnalysisError";
    this.code = code;
  }
}
