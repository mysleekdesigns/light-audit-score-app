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
  `process.cwd()` path joins here — the server must be started from the project root.
- **Audit credentials are the one exception: they travel over IPC, never in the fork's
  environment.** `LH_AUDIT_INPUT` carries credential-FREE options plus an `awaitCredentials`
  flag; the values arrive as a `{ type: "credentials" }` message. A process environment is
  readable by anything running as the same user and is inherited by every descendant — and
  this worker launches Chrome, so an env-borne credential would land in the environment of
  the process rendering untrusted web content. Never move them back into the env, and never
  write them to the `LH_AUDIT_OUTPUT` file (the worker redacts before writing).
- Long-lived `.env` credentials are read INSIDE the worker and are inert unless the target
  host is named in `LH_AUDIT_CREDENTIAL_HOSTS` — an ambient credential must never ride along
  on an audit of a site the user did not scope it to (`src/lib/lighthouse/credentials.ts`).
- Data/DB locations resolve through `src/lib/db/paths.ts` (`LH_DATA_DIR` / `LH_DB_PATH`).
  Don't invent new location env vars without extending that module.
- Median-of-N selection semantics live in `src/lib/lighthouse/median.ts`; any change to run
  count or median selection must update its tests — score trustworthiness is a headline
  product differentiator.
- Chrome comes from chrome-launcher (the user's own installed Chrome). `CHROME_PATH` is a
  user override for a non-standard install location — chrome-launcher reads it natively and
  `src/lib/lighthouse/diagnose.ts` points users at it. Never bundle or download a Chromium.
