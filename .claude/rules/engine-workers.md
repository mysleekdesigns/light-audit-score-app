---
paths:
  - "src/lib/lighthouse/**"
  - "src/lib/queue/**"
  - "scripts/**"
---

# Audit engine & forked-worker invariants

- Lighthouse runs **only** in the forked worker (`scripts/audit-worker.ts`) — never in the
  Next server process. Lighthouse keeps process-global `lh:runner:*` performance marks;
  concurrent in-process runs corrupt each other.
- The worker I/O contract is env-based (`LH_AUDIT_INPUT` / `LH_AUDIT_OUTPUT`, IPC signal);
  the worker script path resolves through the `LH_AUDIT_WORKER_SCRIPT` seam. Never add bare
  `process.cwd()` path joins here — paths must survive Electron/ASAR packaging
  (SAAS_PLAN.md Phase A).
- Data/DB locations resolve through `src/lib/db/paths.ts` (`LH_DATA_DIR` / `LH_DB_PATH`).
  Don't invent new location env vars without extending that module.
- Median-of-N selection semantics live in `src/lib/lighthouse/median.ts`; any change to run
  count or median selection must update its tests — score trustworthiness is a headline
  product differentiator.
- Chrome comes from chrome-launcher (user's installed Chrome; `CHROME_PATH` is the packaged
  fallback). Never bundle or download a separate Chromium.
