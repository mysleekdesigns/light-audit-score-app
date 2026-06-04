# PRD — Local Lighthouse Auditing Tool

> **Status (Phase 15):** Phase 15 complete — completed Lighthouse **and** PageSpeed runs now **stay on the
> console across navigation, a hard refresh, and a server restart** until the user starts a new run (explicit
> Archive/Clear dismissal is Phase 16). The fix reused the existing **DB-as-source-of-truth + small pointer**
> seam with no new state library: both consoles now keep the `localStorage` batch-pointer *through* completion
> (and pre-seed the toast guard so a restored finished run never re-toasts), a new pure
> `reconstructBatch(batchId)` in `persistence.ts` reassembles a *lite* `Batch` from the `batches` row + its
> `runs` rows (lossy-by-design: `perRunScores`/opportunities/BP-breakdown come back empty), and the GET +
> stream audit routes fall back to it on a queue miss (`getBatch(id) ?? reconstructBatch(id)`), so the
> unchanged client reconnect path restores DB-only runs. **Verified for real:** a live example.com run survived
> a genuine kill-and-restart (`GET` → HTTP 200 reconstructed from SQLite, `perf 100 / seo 80`); a headless-Chrome
> pass on **both** `/` and `/pagespeed` confirmed pointer-kept-through-completion, full results restored on hard
> refresh + SPA nav, the completion toast firing once on the run and **zero** on the restore, and zero console
> errors. Lint, typecheck, build, and **459 unit tests** all green (Phase 15 added 6 tests). **Next up:** Phase
> 16 (Archive & Clear dismissal controls). *(The PageSpeed Insights engine and the in-app AI score analysis
> shipped after Phase 14 without dedicated PRD phases; the console hosts both flows, and both got this change.)*
>
> **Planned (Phase 16 — result-persistence UX, NOT yet built):** **Phase 16** adds the explicit dismissal
> controls on a terminal run — **Archive** (remove from the console, keep in History) and **Clear** (remove
> from the console *and* delete the batch from History) — with "start a new run" already replacing the shown
> result. Detailed checklist in §6 (Phase 16).

> **Planned (post-v1 — Phases 11–14):** a **density & multi-device** pass that keeps the existing
> dark "precision-instrument" visual design **untouched** (the cooled `oklch(0.165 …)` palette, cyan
> primary, green/amber/red score bands, Archivo + JetBrains-Mono with tabular figures, hairline 9%
> borders, instrument-grid texture) and only reclaims wasted screen space + borrows proven tools from
> swing's dense Lighthouse console. Scope: a toggleable **dense results table** (one row per URL,
> compact score pills) alongside the ring cards, a **compact control bar**, true **full-bleed**
> wide-screen layouts, **Desktop + Mobile paired** audits, one-click **re-run / regenerate**, **crawl
> exclude-paths + max-count**, and a scheduled **daily archive**. Detailed checklists in §6
> (Phases 11–14). (The swing layout was analysed from a full-page screenshot — its live site blocks
> automated fetch behind an invalid-cert-authority, so crawl/stealth/fetch all failed.)

> **Status:** Phase 14 complete — **all 15 phases (0–14) are done.** The **Scheduled daily archive** layer adds a tiny
> `globalThis`-pinned scheduler that fires saved targets through the *existing* `AuditQueue.createBatch` path (no new
> queue — just a new caller), with the dark "precision-instrument" identity preserved verbatim. A new `schedules` table
> (migration `0003_sharp_professor_monster.sql`, self-healing on first DB access like Phases 4/10/13) stores `name`,
> `enabled`, `cadence` (daily) + `time` (HH:MM 24h, server-local), a discriminated target (`urls` list OR re-runnable
> `crawl` spec), the same `AuditOptions` shape the queue already consumes, plus `last_fired_at` / `last_batch_id` for
> lifecycle; the migration also adds a nullable `batches.schedule_id` so the Archive view can group batches by schedule.
> Pure unit-tested cadence math (`src/lib/schedules/cadence.ts` → `shouldFireNow`/`nextFireAt`) drives a minute-ticking
> singleton (`getScheduler()`) booted from a new `src/instrumentation.ts` (Next 16's official Node-runtime startup
> hook); each fire resolves the target (URL list direct, or re-runs `discover()` for a crawl spec), submits via the
> unchanged queue with `scheduleId` set, and calls `recordScheduleFire(id, batchId)`. The seam threads `scheduleId`
> through `CreateBatchInput` → `Batch` → `recordBatch` → `BatchInfo` (lineage only, never affects execution). A new
> `/archive` route (SSR mirroring `/history`) renders a client `ArchiveConsole` with one card per schedule (telemetry
> strip · Cadence · Next run · Last run · Total runs · per-`scheduleId` run-history strip), Run now / Pause / Enable /
> Delete actions (POST `/api/schedules/:id/run`, PATCH/DELETE `/api/schedules/:id`, `router.refresh()` after each), and
> a "Save as daily" affordance was wired into the New-Audit form via a shadcn `SaveScheduleDialog`. **Verified for
> real:** a live `POST /api/schedules` created schedule `h4GrAlDxrhRPW5DDXIn0C`; `POST /api/schedules/:id/run`
> force-fired it, producing batch `8Vs5WCjtzwyAPn_aG-epY` with `scheduleId` set, scores **`perf 100 / seo 80`**
> (identical to the Phase-13 example.com baseline); the schedule's `lastFiredAt`/`lastBatchId` updated; SSR `/archive`
> rendered the card with the action buttons; PATCH disable → re-enable round-tripped; an invalid `"25:99"` time → HTTP
> 400 `{code:"invalid_request", issues:[{path:"time", …}]}`; DELETE → 204. The fast-forwarded-clock test
> (`scheduler.test.ts`, 9 tests) asserts due → fire → record-lineage, second-tick no-op, disabled-skip, empty-URLs
> guard, sibling-failure isolation, and `runNow` behaviour. Lint, typecheck, build, and **394 unit tests** all green
> (Phase 14 added **49** new tests — 11 cadence, 29 schedules-schema, 9 scheduler).
>
> **Status (Phase 13):** Phase 13 complete — **Re-run / Regenerate + crawl exclude-paths & max-count**, a small power-user
> pass with the dark "precision-instrument" identity preserved verbatim (no new colours/fonts; the re-run button,
> lineage chip and exclude-paths field reuse only existing primitives). **Re-run** records lineage via a new
> nullable `batches.prior_batch_id` (migration `0002`, self-healing) threaded `CreateBatchRequest` →
> `createBatchBodySchema` → `CreateBatchInput` → `Batch` → `recordBatch`/`BatchInfo` (lineage only, never affects
> execution); a shared `RerunBatchButton` re-submits the exact URLs + options through the unchanged
> `POST /api/audits` then deep-links to a live stream at `/?watch=<batchId>` (a new optional
> `AuditConsole.initialBatchId` seeded by `app/page.tsx` reading `?watch`). The Batch card re-runs the whole batch
> (+ a muted "↻ re-run of <prior>" chip); History re-runs a single page with its own persisted options (a new
> `HistoryRow.options`) — History isn't batch-grouped, so per-run is the documented analogue. **Crawl exclude-paths**
> adds `excludePaths` to the discovery contract: a pure unit-tested `compileExcludePathMatcher` (pathname match —
> wildcard-free = prefix, `*`/`?` = anchored glob) filters at the single `add(...)` chokepoint (sitemap + crawl) and
> skips following excluded links in the BFS; `schema.ts` validates them (≤50, non-empty, ≤200 chars) so an invalid
> entry is the existing structured 400. The crawl panel gained an exclude-paths Textarea and a numeric max-pages
> Input (replacing the 50-item Select). **Verified for real**: a live `example.com` re-run reproduced the original's
> scores + options and rendered the SSR lineage chip; excluding `/history` from a depth-1 crawl of the local app
> returned exactly the other three pages; `excludePaths:["   "]` → HTTP 400 (`excludePaths.0`); `/?watch=` rendered.
> Lint, typecheck, build, and **345 unit tests** all green (Phase 13 added exclude-matcher/schema, `priorBatchId`
> pass-through, queue-lineage, and `HistoryRow.options` tests). Next up: Phase 14 (Scheduled daily archive).
>
> **Status (Phase 12):** Phase 12 complete — **Desktop + Mobile paired audits**. `device: "mobile" | "desktop" | "both"`
> is a request-level fan-out, not an engine concept: `AuditOptions.formFactor` stays a concrete `FormFactor`,
> a pure `resolveFormFactors` (in `options.ts`) expands `"both"` → both factors, and `AuditQueue.createBatch`
> fans each `"both"` URL into two independent isolated-Chrome jobs (`AuditJob.device`, distinct ids → they
> stream independently) that run `{ ...batch.options, formFactor: job.device }` — so the worker path is
> unchanged and each run persists its own device with **no schema change** (`runs.formFactor` already existed;
> `recordFailedRun` now reads `job.device`). A pure, unit-tested `src/lib/pairing/devicePairs.ts`
> (`pairByDevice`/`hasBothDevices`) re-pairs the mobile + desktop items for one URL, consumed by a
> device-aware results **table** (paired Mobile|Desktop pill columns), **ring-card** view (stacked device
> ring-sets), and a **detail sheet** that flips device — all *no-ops* for single-device batches.
> `audits-schema` accepts the new `device` (older bodies → single-device), `AuditDefaults.formFactor` widened
> to `DeviceSelection` (storage key → v4), and the batch-summary device badge is derived from the runs.
> **Verified for real**: a live `both` batch of example.com persisted two runs — mobile + desktop, both
> `100/96/92/80` — each matching a single-device baseline **exactly (within ±5)**; SSR `/batches` shows the
> derived **"both"** badge and `/history` both device rows; a **headless-Chrome 1920px** pass drove the form
> (URL → Both → Run) and rendered the live **paired table (8 score pills, Mobile|Desktop headers, 2/2 done)**
> with **zero console errors**. Lint, typecheck, build, and **323 unit tests** all green (Phase 12 added 9
> pairing tests + fan-out/schema/defaults coverage).
>
> **Status (Phase 11):** Phase 11 complete — the **full-bleed density & wide-screen reclaim** pass is in, a pure
> *layout + tooling* change with the dark "precision-instrument" identity preserved verbatim (no new
> colours/fonts; the new pill, toggle, table and legend reuse only the existing score-band tokens +
> Archivo/JetBrains-Mono). The band→colour helper (already shared in `src/lib/scores.ts`) gained
> `scoreBandChipClass`/`scoreChipClass`/`scoreBandSolidClass`, feeding a new **`ScorePill`** (dense
> counterpart to the ring). Live results + History now toggle between a **dense one-row-per-URL table**
> (`results-table.tsx`: path · 4 score pills · inline micro-CWV · env chip · status · `View →` into the
> unchanged detail sheet) and the **ring-card grid** (breakpoints raised to `…xl:grid-cols-4 2xl:grid-cols-5`,
> smaller rings) via a shared **`ResultsViewToggle`**; the choice is persisted in
> `AuditDefaults.resultsView` (default **table**, storage key → v3). The New-Audit form collapsed its
> ~440 px right rail into a **dense horizontal control bar** so the URL textarea + results span full width;
> the wide pages were right-sized (batch cards flow `xl:grid-cols-2 2xl:grid-cols-3`, the trend chart
> height capped, the compare Trend/Diff cards side-by-side on `xl`, History rows densified); and a
> site-wide **footer score-band legend** (`ScoreBandLegend`) was added. **Verified for real**: lint,
> typecheck, build, and **302 unit tests** green, plus a **1920 px headless-Chrome** pass against a
> production build — live dense table + cards toggle + detail sheet (full category readout + CWV),
> `/history` 88 rows with the toggle **persisting across reload**, `/batches` 63-card grid, the footer
> legend, `/compare` hydrating, and **zero console errors**. Next up: Phase 12 (Desktop + Mobile paired
> audits).
>
> **Status (Phase 10):** Phase 10 complete — **all 11 phases (0–10) are done.** The **Environment visibility &
> drift warnings** layer closes out the build: every live result card + the batch-summary cards now
> show an **environment badge** (`benchmarkIndex` "CPU/Memory Power" + the effective throttling method
> + CPU multiplier, formatted by pure `src/lib/lighthouse/environment-format.ts`), and a pure,
> unit-tested **drift detector** (`src/lib/lighthouse/drift.ts` → `assessDrift`) flags three signals
> when Performance is in scope — host-power drift (applied multiplier vs `recommendCpuMultiplier`),
> a wide `benchmarkIndex` spread across a batch's runs, and concurrency contention — rendered by a
> shared **`DriftWarning`** with a one-click "Calibrate →" link. The engine now collects
> `perRunEnvironments` parallel to `perRunScores`, so the detail sheet surfaces each run's
> `benchmarkIndex` alongside its scores (closing §8's "surface per-run spread" for the CPU dimension),
> and the median run's environment is **persisted** (new nullable `runs` columns `benchmark_index` /
> `host_user_agent` / `throttling_method` / `cpu_slowdown_multiplier`, migration `0001`, self-healed at
> runtime; legacy rows degrade to `environment: null`). **Verified for real**: a live
> mobile·simulated·1-run·concurrency-2 batch (example.com `benchmarkIndex 3900.5` / iana `3904`) drove
> the SSR `/batches` page to render the badge, the "Host power 3901–3904 across 2 runs" spread, and a
> drift warning firing both the host-power signal ("…more powerful than the 4× CPU throttle targets…
> Calibrate to ~9×") and the concurrency signal ("Ran at concurrency 2 … Re-run with accuracy mode") —
> with a working Calibrate link. README gained a "Calibration & DevTools parity" section. Lint,
> typecheck, build, and **298 unit tests** all green (Phase 10 added 22 drift/environment-format tests).
>
> **Status (prior, retained for context):** Phase 9 complete — the **Calibration & "Match DevTools" parity** layer is in. On top
> of Phase 8's engine knobs, the tool now turns them into one-click parity with the Chrome DevTools
> Lighthouse panel. **Calibrate** (`src/lib/lighthouse/calibrate.ts`, pure + unit-tested) maps a
> run's `benchmarkIndex` to a device class and a recommended `cpuSlowdownMultiplier` via the official
> bracket table (anchored on the doc's 4×@high-end-desktop fact: `round(benchmarkIndex / 437.5)`);
> the form's Calibrate button reuses the latest run's `benchmarkIndex` and persists the applied
> multiplier. **Accuracy mode** (`resolveEffectiveConcurrency` in `queue/types.ts`; an `accuracyMode`
> flag threaded request→schema→`CreateBatchInput`→`AuditQueue`) forces effective concurrency to 1
> when Performance is in scope — without mutating the saved setting — so parallel Chromes can't
> contend during the simulated-throttling trace and deflate scores. The **"Match DevTools" preset**
> (`MATCH_DEVTOOLS_PRESET`) sets mobile·simulated·1 run·concurrency 1·accuracy-on (4× auto). The
> New-Audit form persists throttling/CPU/accuracy via `useAuditDefaults` (`AuditDefaults` extended,
> storage key → v2) and a new **Run-config card** surfaces throttling + effective multiplier +
> calibration. **Verified for real**: a mobile·simulated·1-run audit of example.com reported
> `simulate` / `cpuSlowdownMultiplier:4` / `benchmarkIndex:4057.5` — exactly the panel's mobile
> defaults (so directly comparable), with the calibrator recommending ~9× to re-target mid-tier
> mobile on this fast host. Lint, typecheck, build, and **276 unit tests** all green. **Next up:**
> Phase 10
> (environment badge + drift warnings). Phase 7's polish layer remains complete:
> **export** (History exports its filtered rows and each Batch exports its runs as JSON/CSV +
> bulk-opens their HTML reports, via pure unit-tested serializers in `src/lib/export/`);
> **settings persistence** (default device / runs / concurrency / categories + per-category pass
> thresholds remembered in `localStorage` through an SSR-safe `useSyncExternalStore` store,
> `src/hooks/useAuditDefaults.ts` + `src/lib/settings/`); **graceful failure handling** (a pure
> classifier, `src/lib/lighthouse/diagnose.ts`, turns Chrome-launch / DNS / unreachable / timeout
> / Lighthouse `runtimeError` failures into plain-English messages, `runAudit` fails fast on a
> hung load via `maxWaitForLoad` and never returns bogus scores for a page that didn't render);
> **loading / error / 404 states** (App-Router `loading.tsx` skeletons + `error.tsx` /
> `global-error.tsx` / `not-found.tsx`); and a full **`README.md`**. **Verified for real** with a
> live end-to-end pass — crawl `localhost` → batch-audit the 4 discovered pages (4/4 done,
> concurrency capped) → 35 persisted History rows → Compare/Batches hydrate in headless Chrome
> with **zero console errors** → the shipped serializers produced a valid 35-record JSON + 36-line
> CSV from the real rows → two unreachable hosts failed with friendly classified messages. Lint,
> typecheck, build, and **244 unit tests** all green (Phase 7 added 20 settings/export +
> 15 engine-diagnose tests). Phases 1–6 (engine, median-of-N, forked-process queue, API/SSE, live
> Audit UI, SQLite persistence + History, crawl/sitemap discovery, comparison & trends) remain
> complete underneath. The **Calibration & Accuracy** layer (Phases 8–10) makes local scores
> matchable to the Chrome DevTools Lighthouse panel — see §3's host-parity finding for the why.

## 1. Overview

A **locally-run web app** to reliably test the Lighthouse scores of websites, with the
ability to **audit multiple pages at once**. Built with **Next.js + Tailwind CSS +
shadcn/ui**. Runs entirely on the local machine and audits arbitrary URL links.

Node v24 and Google Chrome are already installed locally — both prerequisites for the
Lighthouse engine.

## 2. Goals & non-goals

**Goals**
- Audit one or many URLs locally and reliably (stable, comparable scores).
- Run multiple pages concurrently with bounded, configurable parallelism.
- Discover pages by pasting a list **and** by crawling a site (sitemap + shallow crawl).
- Persist every run (SQLite + report files) for history and before/after comparison.
- Clean dashboard UI: live progress, score rings, Core Web Vitals, drill-down reports.

**Non-goals**
- No PageSpeed Insights / CrUX field data (local lab data only).
- Not a hosted/multi-user SaaS — single-user local tool.

## 3. Research findings that shaped this design
- **Engine**: the `lighthouse` npm module (v13 — PWA category removed) driven by
  `chrome-launcher` is the canonical way to run Lighthouse programmatically. It is the
  *same engine* PageSpeed Insights uses, so local lab scores are legitimate.
- **Reliability is the hard part**: Lighthouse scores vary **±5 points even on identical
  runs** (TBT, a CPU-sensitive metric, is 30% of the performance score). Google's own
  anti-variance guidance is to **run 3–5 times and take the median**. Lighthouse ships
  `computeMedianRun` for exactly this.
- **Concurrency tension**: running many audits in parallel on one machine causes CPU
  contention that *distorts* performance scores. Mature tools (Unlighthouse) cap
  concurrency to CPU-core count. The correct design is a **bounded worker queue** where
  each job gets its **own fresh, isolated Chrome instance** (separate `--user-data-dir`,
  cold cache). "Run many at once" and "reliable scores" are reconciled by bounded
  concurrency + median-of-N, both user-configurable with a clear accuracy warning.
- **Next.js fit**: audits take ~10–30s each, so they cannot block an HTTP request.
  We need a job queue + progress streaming (SSE), running in the **Node runtime**
  (Lighthouse cannot run on the Edge runtime), with native deps externalized from the
  bundle.
- **Parity with the DevTools panel depends on the *host*, not just the config.** Both this
  tool and the DevTools Lighthouse panel default to **simulated throttling** with a constant
  **4× CPU multiplier**, so the throttling *method* is not the gap. Simulated throttling derives
  its whole estimate from the initial **unthrottled** load trace, so any CPU contention during
  that trace inflates TBT/TTI/LCP — meaning running several headless Chrome instances
  concurrently (our default 3) **deflates** Performance vs a solo DevTools run. CPU throttling is
  also expressed *relative to the host's* `benchmarkIndex`; 4× only lands on the mid-tier-mobile
  target from a high-end desktop, so an over/under-powered or thermally-throttled machine drifts.
  The tool never surfaces `benchmarkIndex`, hardcodes throttling to `simulated`, and runs cold
  isolated profiles (vs the panel's warm headed profile), so users can't tell when *their
  environment* is the cause. Fix: surface `benchmarkIndex`, let users calibrate the CPU multiplier
  and pick the throttling method, and add an accuracy mode that serializes Performance audits.
  (Source: Lighthouse `docs/throttling.md`; confirmed against the engine config in `runAudit.ts`.)

## 4. Confirmed product decisions
1. **Input**: paste a list of URLs **and** crawl a site to discover pages (sitemap +
   shallow BFS crawl). Paste-list ships first; crawl is a later phase.
2. **Reliability default**: **median of N runs** (default N=3, configurable 1–5).
3. **Persistence**: persist every run to local **SQLite + report files on disk** from the
   start; build the comparison/trend UI as a later phase.
4. **Scope**: **local Lighthouse only**.

---

## 5. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Next.js (App Router, TypeScript, Node runtime)                   │
│                                                                   │
│  UI (shadcn/ui + Tailwind)          Route Handlers (/api/*)       │
│  ─ New Audit (paste / crawl)        ─ POST /api/audits  (create)  │
│  ─ Live progress (SSE)        ◄────▶─ GET  /api/audits/:id        │
│  ─ Results detail                   ─ GET  /api/audits/:id/stream │
│  ─ History & comparison             ─ GET  /api/reports/:runId    │
│                                     ─ GET  /api/history           │
│                                                                   │
│        ┌──────────────────────────────────────────────┐          │
│        │  AuditQueue (singleton on globalThis)          │          │
│        │  p-queue, concurrency = N (default 3)          │          │
│        │  emits progress events ─► SSE subscribers      │          │
│        └───────────────┬────────────────────────────────┘          │
│                        │ per job                                   │
│            ┌───────────▼───────────┐                              │
│            │ runAudit(url, opts)    │  ×N runs → computeMedianRun  │
│            │  chrome-launcher       │  (fresh isolated Chrome)     │
│            │  lighthouse() → LHR    │                              │
│            └───────────┬───────────┘                              │
│                        │                                          │
│   SQLite (better-sqlite3 + Drizzle)   ./data/reports/*.{json,html} │
└─────────────────────────────────────────────────────────────────┘
```

**Why an in-process `globalThis` singleton queue (not Redis/BullMQ)**: it's a single-user
local tool. An in-process bounded queue keeps setup to zero, runs offline, and is plenty
performant. Pinning the instance to `globalThis` survives Next dev-mode HMR resets.
Results are durably persisted to SQLite + disk, so nothing is lost on restart.

### Key libraries
| Concern | Choice | Notes |
|---|---|---|
| Audit engine | `lighthouse` (v13) | Node API: `lighthouse(url, flags, config)` → `lhr` |
| Browser | `chrome-launcher` | Fresh isolated instance per run |
| Median selection | `lighthouse/core/lib/median-run.js` | `computeMedianRun([...lhr])` |
| Concurrency | `p-queue` | Bounded, configurable concurrency |
| DB | `better-sqlite3` + `drizzle-orm` | Synchronous, fast, typed schema + migrations |
| Crawl | `cheerio` + `fast-xml-parser` | Link extraction + sitemap parsing |
| Validation | `zod` | API input validation |
| Charts | shadcn charts (Recharts) | Trend sparklines / comparison |
| IDs | `nanoid` | Batch/run IDs |

### Critical Next.js config (`next.config.ts`)
- `serverExternalPackages: ['lighthouse', 'chrome-launcher', 'better-sqlite3']` so native
  / ESM deps aren't bundled.
- All audit route handlers: `export const runtime = 'nodejs'` and
  `export const dynamic = 'force-dynamic'`.

### Reliability / accuracy defaults
- **Median of N=3** runs per URL (configurable 1–5).
- **Concurrency default 3**, configurable; UI warns that high concurrency reduces
  performance-score accuracy on a single machine.
- Each run: fresh Chrome, unique `--user-data-dir` (cold cache), `--headless=new`.
- Configurable **form factor** (mobile default / desktop) and **throttling** (simulated
  default / applied) — the biggest score levers — exposed in settings.
- Categories: Performance, Accessibility, Best Practices, SEO (all on by default).

---

## 6. Phased plan with checklists

### Phase 0 — Scaffold & foundation
- [x] `create-next-app` (App Router, TypeScript, Tailwind, ESLint, `src/` dir)
- [x] Init `shadcn/ui`; add base components (button, card, input, textarea, table,
      badge, progress, tabs, dialog, sonner/toast, select, tooltip)
- [x] Configure `next.config.ts` (`serverExternalPackages`, Node runtime defaults)
- [x] Add deps: `lighthouse`, `chrome-launcher`, `p-queue`, `better-sqlite3`,
      `drizzle-orm`, `drizzle-kit`, `cheerio`, `fast-xml-parser`, `zod`, `nanoid`
- [x] App shell: header, nav (New Audit / History), dark mode, base layout
- **Verify**: `npm run dev` serves the shell; shadcn components render. ✅

### Phase 1 — Core Lighthouse engine (headless, UI-independent)
- [x] `src/lib/lighthouse/runAudit.ts`: launch isolated Chrome, run `lighthouse()`,
      return parsed result (scores, Core Web Vitals, opportunities, raw LHR)
- [x] Median-of-N: run N times, `computeMedianRun`, return median + per-run scores
- [x] Options model: form factor, throttling, categories, runs (zod schema + defaults)
- [x] Robust teardown: always kill Chrome / clean temp `user-data-dir`, even on error
- [x] `scripts/audit-cli.ts`: standalone runner — run via `npm run audit -- <url>`
      (see deviation note below; the same script is `scripts/audit-cli.ts`)
- [x] **Verify**: ran the CLI against `example.com` and `www.wikipedia.org`; category
      scores **exactly matched** a manual `npx lighthouse <url>` run (well within the
      documented ±5 variance). Teardown leaves no temp `user-data-dir` or stray Chrome.

> **Phase 1 deviation — runner is `node`, not `tsx`.** `tsx` transpiles with
> esbuild's hardcoded `keepNames: true`, which injects `__name(...)` wrappers into
> Lighthouse's source. Lighthouse serializes some of those functions (e.g.
> `computeBenchmarkIndex`) and evaluates them in the browser page, where `__name`
> is undefined → `ReferenceError: __name is not defined`. Node 24's native TS
> type-stripping does no such transform, so the CLI runs under
> `node --import ./scripts/alias-hooks.mjs scripts/audit-cli.ts` (wired as
> `npm run audit`). `scripts/alias-hooks.mjs` is a tiny `module.registerHooks`
> resolver that maps the `@/*` path alias for native Node. Engine library code is
> unaffected (it will run inside Next's Node runtime, which doesn't use esbuild
> keepNames).

### Phase 2 — Job queue, batch orchestration & API
- [x] `src/lib/queue/AuditQueue.ts`: `p-queue` singleton on `globalThis`, configurable
      concurrency, event emitter for progress
- [x] Batch model: a batch = many URL jobs; per-job status
      (queued/running/done/error) + result
- [x] Route handlers: `POST /api/audits` (create batch), `GET /api/audits/:id`,
      `GET /api/audits/:id/stream` (SSE), `GET /api/reports/:runId`
- [x] zod validation + structured error responses; concurrency guardrails
- [x] **Verify**: `curl` POST a 3-URL batch at concurrency 3; SSE streamed
      snapshot → 3× `job-completed` → `batch-completed`; `GET /api/audits/:id`
      returned the final JSON and `GET /api/reports/:runId` returned the full LHR
      JSON (60 audits) + a 313 KB standalone HTML report. All 3 URLs succeeded.

> **Phase 2 deviation — each job runs in its own forked process.** The PRD §5
> design assumed bounded concurrency over jobs that each get a fresh isolated
> *Chrome*. That isn't sufficient: Lighthouse stores its `lh:runner:*` performance
> marks in **process-global** state, so two `lighthouse()` calls running
> concurrently in the same Node process corrupt each other (`The "start
> lh:runner:gather" performance mark has not been set`) — verified: at
> concurrency 2 one of two URLs reliably failed; at concurrency 1 both succeeded.
> The fix (matching how Unlighthouse achieves real concurrency, PRD §3) is
> process isolation: the queue calls `runAuditInWorker` (`src/lib/queue/runAuditWorker.ts`),
> which `fork`s `scripts/audit-worker.ts` per job under the **same launcher the
> Phase 1 CLI uses** (`node --import ./scripts/alias-hooks.mjs …` — native TS +
> `@/` alias, not tsx, to avoid the `__name` bug). The child runs the unchanged
> `runAudit` (N sequential runs for one URL), writes the full `AuditResult` to a
> temp file, and signals completion over IPC; the parent reads it and always
> removes the temp file (timeout-guarded at 5 min/job). Bonus: `lighthouse` /
> `chrome-launcher` are now imported only in the child, never in the Next bundle.

### Phase 3 — Audit UI (paste list + live results)
- [x] New Audit page: URL textarea (one per line / CSV), settings panel (device, runs,
      concurrency, categories) with the accuracy warning
- [x] Live progress: per-URL cards (status, progress), category **score rings** (color
      thresholds 0–49 red / 50–89 orange / 90–100 green) + Core Web Vitals (LCP, CLS,
      TBT, FCP, SI, TTI)
- [x] Results detail drawer/page: full metrics, opportunities & diagnostics, button to
      open the stored full HTML report
- [x] SSE client hook with reconnect; toasts on completion/failure
- [x] **Verify**: in-browser (headless Chrome via CDP), pasted 3 URLs and clicked Run;
      cards streamed queued→running (skeletons)→done with live score rings + Core Web
      Vitals, the COMPLETE strip hit 3/3, and the detail drawer opened with full metrics,
      opportunities and the "Open full HTML report" link. Scores matched the Phase 1/2
      CLI (example.com 100/96/92/80, LCP 0.8 s, TBT 0 ms) within ±5 variance.

> **Phase 3 build fix — Turbopack + `child_process.fork`.** Next 16 makes Turbopack the
> default `next build` bundler, which constant-folded the Phase-2 worker path
> (`fork(path.resolve(process.cwd(), "scripts/audit-worker.ts"))`) into a module specifier
> and failed the build (`Can't resolve scripts/audit-worker.ts` — reproduced on the
> Phase-2 commit, so it predated this phase). Fixed in `runAuditWorker.ts` by handing
> `fork` an opaque `process.env.LH_AUDIT_WORKER_SCRIPT` lookup (defaulted via `??=` to the
> resolved path) so the analyzer leaves the out-of-bundle worker alone; runtime behaviour
> is unchanged and the env var doubles as an explicit override hook.

### Phase 4 — Persistence & history
- [x] Drizzle schema: `batches`, `runs` (per URL: scores, metrics, options, timestamp,
      report file paths); migrations via `drizzle-kit`
- [x] Save median LHR as JSON **and** the Lighthouse HTML report to `./data/reports/`;
      index row in SQLite
- [x] Wire queue → DB writes; serve stored reports via `/api/reports/:runId`
- [x] History page: sortable/filterable table of past runs (by URL, date, score)
- [x] **Verify**: ran a real audit through `POST /api/audits` (example.com → 100/96/92/80,
      matching Phases 1–3); confirmed the SQLite row + `./data/reports/<runId>.{json,html}`
      (211 KB JSON / 397 KB HTML) were written, then **killed and restarted the server**
      (fresh, empty in-memory queue) and confirmed `/api/history`, the `/history` page (SSR),
      and `GET /api/reports/<runId>?format=html|json` all still returned the run and reopened
      the byte-identical reports **from disk** (not the in-memory fallback).

> **Phase 4 design notes.** (1) **Self-healing migrations.** The runtime DB client
> (`src/lib/db/client.ts`, an HMR-safe `globalThis` singleton like the queue) opens SQLite in
> WAL mode and applies the generated `drizzle/` migrations on first access, so a fresh checkout
> persists with no manual migrate step. (2) **Disk reports written parent-side.** The queue
> hands the full lhr-bearing `AuditResult` to `recordRun`, which writes the raw LHR JSON and a
> best-effort standalone HTML report (via Lighthouse's `ReportGenerator`, dynamic-imported so it
> stays out of the bundle — `lighthouse` is in `serverExternalPackages`) under `./data/reports/`,
> then indexes the run. (3) **Persistence never throws.** Every `src/lib/db/persistence.ts`
> export guards + logs internally, so a DB/disk failure can't flip an audit that already
> succeeded in-memory. (4) **Reports serve from disk with an in-memory fallback.**
> `GET /api/reports/:runId` reads the persisted file (surviving restarts); only runs not yet
> persisted fall back to `getJobResult`. (5) `./data/` (DB + reports) is gitignored; the
> `drizzle/` migrations are committed.

### Phase 5 — Site discovery (crawl + sitemap)
- [x] `src/lib/crawl/discover.ts`: fetch `sitemap.xml` (+ sitemap index) via
      `fast-xml-parser`; optional shallow BFS crawl with `cheerio`, bounded by
      max-depth and max-pages, same-origin only, respect `robots.txt`
- [x] New Audit UI: "Crawl a site" mode (domain + depth + max pages + sitemap toggle),
      preview/edit discovered URLs before auditing
- [x] Feed discovered URLs into the existing batch queue
- [x] **Verify**: started the dev server and crawled it as a known small site via
      `POST /api/discover` (`http://localhost:3000`, depth 1) — discovered set was exactly
      correct (`/` at depth 0 + `/history` at depth 1, same-origin only, no cross-origin
      links leaked, `robotsBlocked:false`, accurate "no sitemap" warning). Fed those two
      discovered URLs straight into `POST /api/audits` and both audited successfully
      (`completed`, done 2/2, perf 71/76 · seo 100/100, 0 errors). Bad input → structured
      400 (`invalid_request` + per-field issues); `GET` → structured 405.

> **Phase 5 design notes.** (1) **Discovery is server-side.** A `POST /api/discover`
> route (Node runtime, `force-dynamic`) validates a `DiscoverRequest` with zod (same
> trimmed http/https-only rule as `audits-schema`, toggles defaulted, depth/pages clamped)
> and calls `discover()` — arbitrary cross-origin fetches + `robots.txt` can't run from the
> browser. `src/lib/crawl/types.ts` is the shared contract both the engine and the UI client
> code against. (2) **Modular engine.** `robots.ts` (parse `User-agent`/`Allow`/`Disallow`/
> `Sitemap`, longest-match Allow-over-Disallow for our `LighthouseAuditBot` UA, missing
> robots = allow-all), `sitemap.ts` (`fast-xml-parser`, urlset + recursive sitemap-index
> bounded to ≤20 docs), `discover.ts` (orchestrates: same-origin filter, robots-gated BFS
> crawl with `cheerio`, sitemap wins on cross-source dedupe, per-request 10s `AbortController`
> + total fetch bounds; best-effort — fetch failures become `warnings`, never throw).
> (3) **Page cap = batch cap.** `MAX_PAGES` is capped at 50 to match the batch's `MAX_URLS`,
> so a fully-selected discovery set always submits without tripping that limit. (4) **Feeds
> the existing queue unchanged.** The crawl tab previews/edits discovered URLs and submits the
> selected set through the *same* `onSubmit(CreateBatchRequest)` → `POST /api/audits` path the
> paste tab uses — no change to the queue, the batch contract, or `NewAuditFormProps`.

### Phase 6 — Comparison & trends
- [x] Compare view: pick two runs of the same URL → score/metric diff (deltas, up/down)
- [x] Trend sparklines per URL over time (shadcn charts / Recharts)
- [x] Batch summary: averages, best/worst pages, pass/fail vs configurable thresholds
- [x] **Verify**: audited one URL (a local page) twice with a real change between (degraded
      its A11y/SEO markup), then confirmed both the **diff** and the **trend** reflect it.
      `/compare` (URL `http://localhost:8099/`, 2 runs): the score-trend chart shows the
      Accessibility line plunging **89 → 13**; the run diff (baseline = clean run, comparison =
      degraded run) reads **A11y 89→13 −76 regressed, SEO 83→67 −16 regressed, Best Practices
      92→100 +8 improved, Performance 100→100 ±0**, plus the Core Web Vitals delta table
      (lower-is-better semantics). `/batches` summarised each batch's average scores, best/worst
      page, and pass/fail counts against configurable thresholds (degraded batch: A11y **0/1**,
      SEO **0/1**, Perf **1/1** at threshold 90). Verified the *shipped* diff/trend helpers
      against the *real persisted* rows, then in a headless browser against the hydrated UI.

> **Phase 6 design notes.** (1) **Two new URL-/batch-centric views, fed by the Phase-4 seam.**
> `/compare` (server component → `<CompareConsole>`) groups `listHistory()` rows by URL: a
> per-URL **score-trend** line chart + per-category sparklines (shadcn `chart`/Recharts), and a
> two-run **diff** of category scores (higher = better) and Core Web Vitals (lower = better),
> each delta shown with an up/down arrow **and** an `sr-only` direction word so colour is never
> the sole signal. `/batches` (server component → `<BatchSummaryConsole>`) groups runs by
> `batchId` and, per batch, shows average scores (gauges), best/worst page by an overall-score
> mean, and pass/fail counts against **client-configurable** per-category thresholds (default 90;
> persisting them is Phase 7). (2) **Seam additions (the only shared edits).** `HistoryRow` now
> carries parsed median `metrics: CoreWebVitals | null` (so the CWV diff needs no extra fetch),
> and a new `listBatches(): BatchInfo[]` exposes batch metadata — both still never-throw, both
> unit-tested. All comparison/summary math lives in pure, React-free helpers
> (`src/lib/compare/diff.ts`, `src/lib/batch-summary/summary.ts`) with 42 new unit tests. (3)
> **Charts are client-only.** Recharts (`^3.8.0`, via `npx shadcn add chart`) renders inside
> `"use client"` components; the pages stay server components reading the DB directly, exactly
> like the History page. (4) **Failed/unscored runs** are excluded from trends/averages and
> count as *fail* in the batch pass/fail tally (an errored page hasn't met the bar).

### Phase 7 — Polish & docs
- [x] Export: download batch results as JSON/CSV; bulk-open reports
- [x] Settings persistence (default device, runs, concurrency, score thresholds)
- [x] Graceful handling: unreachable URLs, redirects, timeouts, Chrome launch failures
- [x] Empty/loading/error states; keyboard & a11y polish
- [x] `README.md`: setup, run, how scores are computed, accuracy notes
- [x] **Verify**: full end-to-end pass — drove it live against the dev server.
      **Crawl** `POST /api/discover` (`http://localhost:3000`, depth 1) → exactly
      `/`, `/history`, `/compare`, `/batches`. **Batch audit** those 4 via
      `POST /api/audits` (desktop, concurrency 2) → **4/4 done, 0 errors**,
      concurrency capped at 2 throughout (~97 perf / 100 a11y / 100 seo).
      **History** `/api/history` returned 35 persisted rows (scores + parsed
      median CWVs + on-disk reports). **Compare/Batches** SSR + hydrated in
      headless Chrome with **zero console errors** and the Run-Diff / Score-Trend
      / Pass-thresholds / export controls live in the DOM. **Export**: the shipped
      `rowsToJson`/`rowsToCsv` serializers run over the *real* 35 rows produced a
      valid 35-record JSON array and a 36-line CSV (header + 35); the
      "Export JSON/CSV" + "Open all reports" buttons render with proper
      `aria-label`s. **Graceful errors**: a batch of two unreachable hosts
      (`*.invalid`, `localhost:9`) finished `completed_with_errors` (2/2 error)
      with friendly classified messages, not stack traces. Lint, typecheck, build,
      and **244 unit tests** all green (Phase 7 added 20 settings/export +
      15 engine-diagnose tests).

> **Phase 7 design notes.** (1) **Settings persistence is a tiny client store, not
> a server concern.** A single shared module-level store behind
> `useAuditDefaults` (`src/hooks/useAuditDefaults.ts`) backs {@link AuditDefaults}
> (default device / runs / concurrency / categories + per-category pass
> thresholds) with `localStorage`, exposed via `useSyncExternalStore` so the read
> is SSR-safe by construction — `getServerSnapshot` returns the factory defaults
> (matching hydration) and the persisted blob is read only once subscribed, with a
> `loaded` flag for the false→true transition. The pure shape + a never-throwing
> `normalizeDefaults` (every field clamped/whitelisted to the engine's own bounds)
> live in `src/lib/settings/defaults.ts` (unit-tested); `update(partial)` merges +
> re-validates so the New Audit form and the Batch-Summary thresholds each write
> their own slice without clobbering the rest. (2) **Export = pure serializers +
> a thin DOM layer.** `src/lib/export/exporters.ts` (`rowsToJson`/`rowsToCsv`,
> unit-tested, RFC-4180 CSV escaping) projects `HistoryRow`s into a flat per-run
> record (URLs, device, status, the 4 scores, the 6 CWVs, timing/version,
> error message — no heavy LHR); `src/lib/export/download.ts` (browser-only) does
> the Blob download + `openUrlsInNewTabs` for bulk-open. History exports the
> *currently-visible* (filtered+sorted) rows; each Batch card exports its own runs
> and opens all of its stored HTML reports, with a popup-blocker toast fallback.
> (3) **Graceful handling lives in a pure classifier.** `src/lib/lighthouse/diagnose.ts`
> (`runtimeErrorMessage(lhr)` + `classifyAuditError(err, url)`, unit-tested) maps
> Chrome-launch failures, DNS/unreachable, timeouts, and Lighthouse `runtimeError`
> codes (e.g. `FAILED_DOCUMENT_REQUEST`, `NO_FCP`) to plain-English messages.
> `runAudit` now throws on a non-null `lhr.runtimeError` (a page that "loaded" but
> never rendered is an error, not bogus scores), re-throws via the classifier, and
> bounds navigation with `maxWaitForLoad` so a hung load fails fast instead of
> waiting the 5-min worker ceiling — the existing always-runs teardown `finally`
> is untouched, and the friendly message survives the worker IPC path to the UI.
> (4) **Loading/error/404 surfaces are App-Router special files.** Route-level
> `loading.tsx` skeletons (root + history/compare/batches) mirror each page's
> layout so content doesn't jump; `error.tsx` / `global-error.tsx` are on-brand
> client boundaries with a "Try again" `reset()`; `not-found.tsx` links home. All
> use `role="status"`/`aria-busy` + `sr-only` "Loading…" and visible focus rings.
> (5) **README** documents setup/run, the median-of-N + isolated-Chrome scoring
> model, the colour bands, and the variance/concurrency accuracy notes.

### Phase 8 — Engine: throttling method + CPU-multiplier controls
- [x] Extend the engine seam: add optional `cpuSlowdownMultiplier?: number` (1–20; omitted =
      Lighthouse's default 4×) to `AuditOptions` (`src/lib/lighthouse/types.ts`) and surface the
      already-typed `throttling` ("simulated" / "applied"). Update `auditOptionsSchema` +
      `resolveAuditOptions` (`src/lib/lighthouse/options.ts`) to validate/clamp + default them.
- [x] Plumb both into the Lighthouse `flags` in `runAudit.ts`: keep the existing
      `throttlingMethod` mapping (`simulate`/`devtools`) and pass `throttling:
      { cpuSlowdownMultiplier }` when set (under `simulate` it scales the simulation; under
      `devtools` it sets the real CPU interrupt rate).
- [x] Unhardcode throttling in the submit path — `new-audit-form.tsx:164` currently forces
      `throttling: "simulated"`; flow the chosen value through `CreateBatchRequest` instead.
- [x] Capture the run's environment into `AuditResult` (`types.ts`): `benchmarkIndex` +
      `hostUserAgent` (from `lhr.environment`) and the *effective* throttling method + multiplier.
- [x] Validate the new fields server-side in `src/lib/api/audits-schema.ts` (enum throttling,
      clamp multiplier) so they pass through `POST /api/audits` unchanged.
- [x] **Verify**: ran the engine/CLI against `example.com` (simulated 4× vs applied 8×) and a
      JS-heavier Wikipedia page (simulated 1× vs 12×). (a) Flags reach Lighthouse: `applied` →
      effective `throttlingMethod: "devtools"`, `simulated` → `"simulate"`, and the chosen
      `cpuSlowdownMultiplier` is read back from `lhr.configSettings` (omitted → Lighthouse's 4×).
      (b) Each result carries `benchmarkIndex` (~4046) + `hostUserAgent`. (c) Expected metric
      shift: holding method/page fixed and raising the multiplier 1×→12× inflated **TBT 0→250 ms**
      and dropped **Performance 65→58**. Lint, typecheck, build, and **263 unit tests** all green
      (Phase 8 added option-schema clamp, flag-mapping, `parseEnvironment`, and audits-schema
      pass-through tests).

> **Phase 8 design notes.** (1) **Network throttling must not be clobbered.** Passing a bare
> `throttling: { cpuSlowdownMultiplier }` flag *replaces* Lighthouse's whole `throttling` object,
> silently dropping the network profile (rttMs/throughputKbps/…). The exported, unit-tested
> `buildThrottlingFlags(options)` in `runAudit.ts` instead *merges* the multiplier over the active
> form factor's default throttling (read from `defaultConfig`/`desktopConfig`), so only the CPU
> field changes — confirmed empirically (mobile + 8× keeps the full 4G-class network values).
> When the multiplier is omitted, no `throttling` flag is sent at all (Lighthouse keeps its 4×).
> (2) **Effective vs requested.** The captured `RunEnvironment` reads the *effective* throttling
> method + multiplier back from `lhr.configSettings` (not just our requested flags), alongside
> `benchmarkIndex` + `hostUserAgent` from `lhr.environment`, via a pure `parseEnvironment(lhr)`.
> `environment` is a required field on `SingleRunResult`/`AuditResult` and rides through
> `AuditResultLite` (so it reaches the API/SSE for Phase 10's environment badge). (3) **No
> `audits-schema.ts` code change.** It already delegates `options` to `auditOptionsSchema`, so the
> clamped multiplier + throttling pass through `POST /api/audits` for free (covered by a new
> pass-through test). (4) **CLI knob.** `scripts/audit-cli.ts` gained `--cpu=N` (aliases
> `--cpu-multiplier`/`--cpu-slowdown`) so the engine's Verify harness can drive the new option.
> (5) **Not yet persisted as columns / surfaced in UI.** Phase 8 only *captures* the environment
> and adds the throttling control; the multiplier UI control, calibration, and the environment
> badge/drift warnings are Phases 9–10.

### Phase 9 — Calibration & "Match DevTools" parity
- [x] **Calibrate** action: run a quick reference benchmark (or reuse one audit's
      `benchmarkIndex`), then map it to a recommended `cpuSlowdownMultiplier` via the official
      bracket table (high-end desktop 1500–2000, mid-tier mobile 125–800, etc. — Lighthouse
      `docs/throttling.md`), and persist the recommendation as a default.
      *Done via the pure, unit-tested `src/lib/lighthouse/calibrate.ts` (`calibrationFor` →
      device class + recommended multiplier, anchored on the doc's 4×@high-end-desktop fact);
      the form's Calibrate button reuses the latest completed run's `benchmarkIndex` (no separate
      benchmark endpoint) and persists the applied multiplier via `useAuditDefaults`.*
- [x] **Accuracy mode** toggle: when Performance is in scope, force the batch's effective
      `concurrency = 1` so the initial unthrottled trace isn't CPU-contended; surface the
      speed↔accuracy tradeoff. Honour an effective-concurrency override in `CreateBatchInput`
      (`src/lib/queue/types.ts`) / `AuditQueue` rather than mutating the user's saved setting.
      *Done: `resolveEffectiveConcurrency(options, concurrency, accuracyMode)` in queue/types.ts;
      `accuracyMode` flows request → schema → `CreateBatchInput` → `AuditQueue.createBatch`, which
      records the effective concurrency. The saved concurrency is never mutated.*
- [x] **"Match DevTools" preset**: one button sets mobile · simulated · 1 run · concurrency 1 —
      the panel's defaults — so a run is directly comparable to a DevTools-panel run.
      *Done: `MATCH_DEVTOOLS_PRESET` in `src/lib/settings/defaults.ts` (also turns accuracy mode on
      and resets the multiplier to Lighthouse's 4×, matching the panel); the form applies it to
      local state + `update(...)`.*
- [x] Expose throttling method + CPU multiplier + the calibrated default in the Run-config card;
      remember them via `useAuditDefaults` (extend `AuditDefaults` + `normalizeDefaults` in
      `src/lib/settings/defaults.ts`, each slice merged without clobbering the others).
      *Done: `AuditDefaults` gained `throttling` / `accuracyMode` / optional `cpuSlowdownMultiplier`
      (storage key → v2); a new `run-config-card.tsx` shows throttling + effective multiplier +
      calibration; the CPU control is a Select ("Auto = Lighthouse 4×" + 1–10× presets) rather than
      a slider, to avoid a new radix dependency.*
- **Verify**: run a URL via the "Match DevTools" preset **and** in the DevTools Lighthouse panel
      (mobile, simulated) on the same machine — category scores land within a few points and the
      reported `benchmarkIndex` matches the panel's "CPU/Memory Power". Confirm a batch with
      accuracy mode on no longer silently deflates Performance vs the same URLs run one-by-one.
      *Verified (engine half): a real mobile·simulated·1-run audit of example.com reported
      `throttlingMethod:"simulate"`, `cpuSlowdownMultiplier:4`, `benchmarkIndex:4057.5` — exactly the
      panel's mobile defaults, so it's directly comparable, and the calibrator correctly recommends
      ~9× to re-target mid-tier mobile on this fast host. Accuracy-mode effective-concurrency and the
      preset are unit-tested. The side-by-side panel comparison is a manual same-machine check.*

### Phase 10 — Environment visibility & drift warnings
- [x] **Environment badge** on each result card + the batch summary: show `benchmarkIndex`
      ("CPU/Memory Power") and the effective throttling method + multiplier the run used.
      *Done: a shared, presentational `EnvironmentBadge` (`src/components/audit/environment-badge.tsx`,
      `compact` chip / `full` readout) formats `benchmarkIndex` + device class + effective method +
      multiplier via pure `src/lib/lighthouse/environment-format.ts`; it rides the live result cards
      and detail sheet (`AuditResultLite` already carries `environment`) and the batch-summary cards
      (median run's environment now persisted — see below).*
- [x] **Drift warning**: flag runs whose `benchmarkIndex` indicates an over/under-powered or
      CPU-contended host (e.g. a wide benchmarkIndex spread across a batch), with a one-click link
      to Calibrate and a note when `concurrency > 1` likely depressed Performance.
      *Done: pure, unit-tested `assessDrift()` (`src/lib/lighthouse/drift.ts`) detects three signals —
      host-power drift (applied vs `recommendCpuMultiplier`), a wide benchmarkIndex spread across runs,
      and concurrency contention — scoped to when Performance is in scope; the shared `DriftWarning`
      (`src/components/audit/drift-warning.tsx`) renders them with a one-click "Calibrate →" link.*
- [x] Surface the **per-run `benchmarkIndex` spread** alongside the existing per-run score spread,
      closing the §8 "surface per-run spread" risk for the CPU dimension too.
      *Done: the engine now collects `perRunEnvironments` parallel to `perRunScores`
      (`AuditResult`/`median.ts`); the detail sheet shows a per-run table (each run's category scores
      **and** its `benchmarkIndex`) + a `benchmarkIndexSpread` min–max summary; the batch summary shows
      the cross-run "Host power min–max" readout.*
- [x] Extend `README.md` accuracy notes with the calibration workflow and "Match DevTools"
      guidance (when to use simulated vs applied throttling, why concurrency affects Performance).
      *Done: new "Calibration & DevTools parity" section (benchmarkIndex & the 4× default, the Calibrate
      workflow, the Match-DevTools preset, simulated vs applied, why concurrency affects Performance,
      the badge/drift warning).*
- [x] **Verify**: a batch run on a deliberately busy machine shows the badge + drift warning;
      running Calibrate updates the recommended multiplier, and a solo accuracy-mode re-run clears
      the warning. Lint, typecheck, build, and the unit suite stay green.
      *Verified for real: a live mobile·simulated·1-run·**concurrency-2** batch of example.com +
      iana.org persisted the median run's environment to the new `runs` columns (example.com
      `benchmarkIndex 3900.5`, iana `3904`, both `simulate`/`4×`; legacy pre-migration rows degrade to
      `environment: null`). The SSR `/batches` page then rendered, from those real rows, the
      environment badge ("Simulated 4×"), the "Host power 3901–3904 across 2 runs" spread, and the drift
      warning reading "**This host (benchmark 3902, high-end desktop) is more powerful than the 4× CPU
      throttle targets, so Performance reads optimistically. Calibrate to ~9× …**" + "**Ran at
      concurrency 2 … Re-run with accuracy mode (concurrency 1) …**" with a working "Calibrate →" link —
      i.e. both the host-power and concurrency signals fired on this fast host. Concurrency-1 / calibrated
      clearing is unit-tested in `drift.test.ts`; the literal side-by-side DevTools-panel comparison is a
      manual same-machine step. Lint, typecheck, build, and **298 unit tests** all green (Phase 10 added
      22 drift + environment-format tests).*

> **Phases 8–10 design notes.** Earlier phases optimised for **throughput** (parallel Chrome via
> p-queue) and **reproducibility** (median-of-N, cold isolated profiles). Both are correct, but
> both diverge from the DevTools panel, which runs **one page solo in a warm headed profile**.
> Rather than abandon throughput, this layer makes the *environment* visible (`benchmarkIndex`)
> and gives the user explicit, calibrated controls to trade speed for parity when they need it:
> Phase 8 adds the engine knobs (throttling method + CPU multiplier) and records the host
> environment; Phase 9 turns those knobs into one-click parity (Calibrate, accuracy mode, "Match
> DevTools"); Phase 10 makes drift legible so a surprising score is explained by the machine, not
> mistaken for a regression. All three reuse the existing seam (`AuditOptions` → `CreateBatchInput`
> → persisted run) and the `useAuditDefaults` store — no new architecture.

---

> **Design constraint for Phases 11–14 (binding for all agents):** these are a *layout-density +
> tooling* pass, **not a redesign**. The visual identity is preserved verbatim — the dark cooled
> palette (`--background oklch(0.165 …)`), cyan primary, the green/amber/red **score bands**, Archivo +
> JetBrains-Mono with `tabular-nums`, hairline (9%) borders, and the instrument-grid texture. No new
> colours, fonts, or generic "shadcn-default" surfaces. We only reclaim wasted horizontal/vertical
> space and add proven tools observed on swing's dense Lighthouse console. All four phases reuse the
> existing seams (`AuditOptions` → `CreateBatchInput` → persisted `runs`; the `/api/discover` +
> `/api/audits` routes; the `useAuditDefaults` store) — no new architecture beyond Phase 14's local
> scheduler. Per CLAUDE.md, UI work here MUST invoke **frontend-design** (drives the visuals) +
> **vercel-react-best-practices** + **shadcn**, then review with **web-design-guidelines**.

### Phase 11 — Full-bleed density & wide-screen reclaim
**Why:** the canvas is already full-width (commit `c53671f`) but the *content* stays sparse — live
results cap at `sm:grid-cols-2` ring cards (~400 px, only 2-across on a 1600 px+ monitor), the
New-Audit form is a tall 2:1 `lg:grid-cols-3` panel with a ~440 px right rail, and History / Compare /
Batches are single-column stacks. Make the content as dense as swing's, in *our* theme.

- [x] **Score-pill primitive** (`src/components/audit/score-pill.tsx`): a small rounded mono chip — a
      dense counterpart to `score-ring.tsx` — reusing the *existing* 0–49 / 50–89 / 90–100 band logic
      and `--score-good/average/poor` tokens (factor the band→colour helper out of `score-ring.tsx`
      so the pill and ring share one source of truth).
      *Done: the band→colour helper was already factored into `@/lib/scores` (`scoreBand`/`scoreColorClass`)
      and shared by the ring; Phase 11 added `scoreBandChipClass`/`scoreChipClass`/`scoreBandSolidClass`
      there (one source of truth, unit-tested) and `ScorePill` consumes them.*
- [x] **Dense results table** (`src/components/audit/results-table.tsx`): one compact row per URL —
      path (mono, truncated, tabular), the 4 category **score pills**, an inline micro-CWV
      (LCP / TBT / CLS), the compact `EnvironmentBadge` chip, the `StatusBadge`, and a `View →` that
      opens the *existing* `audit-detail-sheet.tsx` (full rings + CWV + per-run spread stay there,
      unchanged). Sticky header row, hairline dividers, `tabular-nums`.
      *Done: pure presentational `ResultsTable` (`AuditJob[]` → rows; Skeleton while queued/running,
      em dash on error); the unchanged detail sheet renders the score readout as large numeric figures
      (`CategoryScoreGrid`) rather than rings — "full rings" was loose wording — so the live verify
      asserts the full category readout + CWV.*
- [x] **View toggle** (table ↔ ring-cards) in the live-results header (`audit-results.tsx`) and on
      History; persist the choice via `useAuditDefaults` (extend `AuditDefaults` + `normalizeDefaults`,
      bump the storage key). Default = **table** (hybrid, per the approved decision).
      *Done: `AuditDefaults.resultsView` (`"table"` default, storage key → v3, normalised + unit-tested);
      a shared `ResultsViewToggle` primitive drives both surfaces; SSR-safe via the existing store.*
- [x] Keep the ring-card grid as the alternate view, but **raise its breakpoints**
      (`sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5`) and shrink the ring a touch so
      it is no longer 2-across on wide screens.
      *Done: cards view keeps the host-grouped accordion with the raised breakpoints and `ScoreRings size={48}`.*
- [x] **Compact control bar** for New Audit (`new-audit-form.tsx` + `run-config-card.tsx`): collapse the
      ~440 px right rail into a single dense horizontal toolbar (device · runs · concurrency ·
      throttling · CPU · accuracy · Match-DevTools) so the URL textarea + live results get the full
      width. Every current control, the calibration readout, and the `DriftWarning` stay — re-flowed,
      not removed.
      *Done: the form is now top-down — a dense wrapping control bar (all controls + Calibrate/Match-DevTools
      + the `RunConfigCard` readout + the concurrency `Alert`) above a full-width Target-URLs card + results;
      every handler / `update(...)` / `disabled`/`canSubmit` / `useId` / hydration call preserved.*
- [x] **Right-size the wide pages**: flow `batch-summary-console.tsx` cards in a responsive grid
      (`xl:grid-cols-2 2xl:grid-cols-3`) instead of one-per-row; cap Recharts heights and tighten the
      `compare` diff grid; densify `history-table.tsx` row height. True full-bleed stays (the `<main>`
      already has no `max-w-*`); tune `px`/`gap` for density.
      *Done: batch cards now flow `xl:grid-cols-2 2xl:grid-cols-3`; the trend chart height capped (`h-64`→`h-56`)
      and the compare Trend/Diff cards sit side-by-side on `xl`; History rows densified (`py-2 leading-tight`,
      sticky header) and gained the table↔cards toggle + a ring-card grid over the same filtered rows.*
- [x] **Footer score-band legend**: a compact green/amber/red key (mirroring swing's footer legend).
      *Done: a server-safe `ScoreBandLegend` (token swatches via `scoreBandSolidClass`, range text so colour
      isn't the only signal) rendered site-wide in the layout footer.*
- [x] **Verify**: lint + typecheck + build + the full unit suite green (the band-helper + defaults
      additions get tests); in headless Chrome at 1920 px, a live batch and `/history` render many URL
      rows, the table↔cards toggle persists across reload, the detail sheet still opens with full
      rings / CWV, zero console errors, and a visual check confirms palette / fonts / tokens are
      unchanged.
      *Verified: lint, typecheck, build, and **302 unit tests** all green (Phase 11 added band-chip/solid +
      resultsView normalisation tests). A headless-Chrome pass at **1920×1080** against a production `next start`
      build drove a live example.com batch — the dense results table rendered, the table↔cards toggle flipped to
      the ring-card view (rings present), and `View →` opened the unchanged detail sheet with the full category
      readout (Performance · Accessibility · SEO) + Core Web Vitals. `/history` rendered **88 persisted rows**, the
      table↔cards toggle **persisted across a full reload**, `/batches` rendered its **63-card grid**, the footer
      score-band legend (90–100 … 0–49) was present, `/compare`'s trend chart hydrated, and there were **zero
      console errors** across every page. Palette / fonts / tokens are unchanged by construction — the new pill,
      toggle, table and legend reuse only the existing score-band tokens and Archivo/JetBrains-Mono; no new colours
      or fonts were introduced.*

### Phase 12 — Desktop + Mobile paired audits
**Why:** swing's standout feature — audit both form factors in one run and show paired score columns
per URL. We already persist `device` per run, so this is a job fan-out + a pairing projection, not new
storage.

- [x] **Engine / options**: accept `device: "mobile" | "desktop" | "both"` (resolve `"both"` to the two
      form factors) in `src/lib/lighthouse/types.ts` + `options.ts`; the worker path
      (`runAuditWorker.ts`) is unchanged — `"both"` simply enqueues two independent isolated-Chrome
      jobs.
      *Done: a new `DeviceSelection = FormFactor | "both"` (types.ts) is purely a request-level fan-out
      instruction — `AuditOptions.formFactor` stays a concrete `FormFactor`, so the engine/worker never
      see `"both"`. A pure, unit-tested `resolveFormFactors(device)` (options.ts) maps `"both"` →
      `["mobile","desktop"]`.*
- [x] **Queue / batch**: a `both` URL fans out to two jobs keyed `(url, device)`; thread the per-job
      device through `CreateBatchInput` / `AuditQueue` and the SSE job ids so the two stream
      independently.
      *Done: `AuditJob.device` (required) + `Batch.device` + `CreateBatchInput.device` thread the
      selection through. `AuditQueue.createBatch` fans each URL out over `resolveFormFactors(device)` into
      jobs with globally-contiguous indices + distinct ids (so the two stream independently); each job
      runs `{ ...batch.options, formFactor: job.device }`. Since `runAudit` echoes `options`, `recordRun`
      persists the right per-device `formFactor` with no schema change; `recordFailedRun` now reads
      `job.device` too.*
- [x] **Pairing projection**: a never-throwing `listPairedHistory()` / batch grouping that pairs the
      mobile + desktop `runs` rows for the same `(batchId, url)` (pure, unit-tested) — no schema change.
      *Done: a pure, server-safe `src/lib/pairing/devicePairs.ts` (`pairByDevice` → `DevicePair<T>`,
      `hasBothDevices`, `devicesPresent`) pairs already-fetched live `AuditJob`s **or** persisted
      `HistoryRow`s via caller-supplied accessors (callers group by `batchId` first); 9 unit tests.*
- [x] **UI**: the Phase-11 table gains **Desktop | Mobile** paired pill columns per URL row; the
      ring-card view shows both device ring-sets; the detail sheet flips device. The New-Audit device
      control gains a "Both" option.
      *Done: the results table + ring-cards are device-aware — single-device sets render exactly as before
      (no regression), a both set renders one row/card per URL with paired Mobile|Desktop pill columns /
      stacked ring-sets (each device's `View →` opens its own job). The detail sheet gains a Mobile/Desktop
      header toggle (the console passes the URL's job pair). New-Audit device control gained **Both** and
      submits a top-level `device`; the batch-summary device badge is derived from the runs (`both` when
      mixed). `AuditDefaults.formFactor` widened to `DeviceSelection` (storage key → v4).*
- [x] **API**: `src/lib/api/audits-schema.ts` accepts the new device value (enum / clamp); structured
      errors unchanged.
      *Done: `createBatchBodySchema` gained `device: z.enum(["mobile","desktop","both"]).optional()`;
      `parseCreateBatchBody` resolves `device ?? options.formFactor` into `CreateBatchInput` (older bodies
      stay single-device). Invalid device → the existing structured 400.*
- [x] **Verify**: a real `both` batch of one URL persists two runs (mobile + desktop), the table shows
      paired pills, and each device's scores match a single-device run of the same URL within the
      documented ±5; lint / types / build / tests green.
      *Verified for real: a live `device:both` batch of `example.com` (concurrency 1) persisted **two runs —
      mobile `100/96/92/80` (benchmarkIndex 4038) + desktop `100/96/92/80` (4049)** — and each device matched
      a single-device baseline run of the same URL **exactly (Δ0, within ±5)**. The SSR `/batches` card derives
      the device badge **"both"** ("2 pages · 2 done") from the runs; `/history` shows both device rows. A
      **headless-Chrome 1920px** pass drove the New-Audit form (URL → **Both** → Run): the live results table
      completed **2/2** and rendered **paired Mobile | Desktop headers with 8 score pills** (mobile + desktop),
      with **zero console errors**. Lint, typecheck, build, and **323 unit tests** all green (Phase 12 added the
      9 device-pairing tests + `resolveFormFactors` / device-schema / fan-out / failed-run-device / defaults
      tests).*

### Phase 13 — Re-run / Regenerate + crawl exclude-paths & max-count
**Why:** small, high-value power-user tools from swing's input panel and run list.

- [x] **Re-run / Regenerate**: a button on each Batch card (`batch-summary-console.tsx`) and the History
      batch group that re-submits that batch's exact URLs + options through the *existing*
      `POST /api/audits` path; record the prior batch id so the result is one click from the Phase-6
      compare / trend.
      *Done: a nullable `prior_batch_id` column was added to `batches` (migration `0002_empty_bastion.sql`,
      self-healing on first DB access like Phase 4/10) and `priorBatchId` threaded through the seam —
      `CreateBatchRequest`/`createBatchBodySchema` → `CreateBatchInput` → `Batch` → `recordBatch` →
      `BatchInfo` (it never affects execution, only lineage). A shared client `RerunBatchButton`
      (`src/components/audit/rerun-batch-button.tsx`) re-submits via `createBatch(...)` then deep-links to
      the live stream at `/?watch=<batchId>` (a new optional `AuditConsole` `initialBatchId` seeded by
      `app/page.tsx` reading `?watch`; the SSE handler replays a snapshot on connect). The Batch card
      renders a labelled "Re-run" (re-running the batch's deduped URLs + `batch.options`/`device`/
      `concurrency`) plus a muted "↻ re-run of <prior>" lineage chip when `batch.priorBatchId` is set.
      **Deviation:** History is a flat run list (not batch-grouped), so the History affordance is a
      **per-run** re-run icon — re-running that one page with its own persisted options (a new
      `HistoryRow.options`, parsed from the stored `runs.options`, gives full fidelity: categories /
      throttling / multiplier, not just device) — which is the History analogue of "the batch group" and
      also retries errored rows.*
- [x] **Crawl exclude-paths**: extend `DiscoverRequest` + `src/lib/crawl/discover.ts` with
      `excludePaths: string[]` (prefix / glob, same-origin), filtered during *both* the BFS crawl and
      the sitemap merge; add an "exclude paths" textarea to `crawl-panel.tsx` (swing's "Don't crawl
      these links").
      *Done: `excludePaths` added to `DiscoverRequest`/`DiscoverInput`; a pure, unit-tested
      `compileExcludePathMatcher` (in `crawl/types.ts`, import-safe) matches against the URL **pathname**
      (case-sensitive, leading `/` optional) — a wildcard-free pattern is a **prefix** match (`/blog`),
      a pattern with `*`/`?` is a both-ends-anchored **glob** (`/admin/*`, `*.pdf`). `discover.ts` builds
      it once and filters at the single `add(...)` chokepoint (so sitemap + crawl results drop uniformly)
      and also skips *following* excluded links during the BFS (mirroring robots). `schema.ts` validates
      `excludePaths` (≤ `MAX_EXCLUDE_PATHS` = 50, each non-empty after trim and ≤ 200 chars) → an invalid
      entry is the existing structured 400. `crawl-panel.tsx` gained an "Exclude paths" Textarea
      (one pattern/line, newline-split + trimmed).*
- [x] **Max-count control**: surface a user `maxPages` input in the crawl panel (the engine already
      clamps to `MAX_PAGES` = 50 = the batch cap).
      *Done: the clunky 50-item Max-pages `Select` was replaced with a numeric `Input`
      (`type="number"`, `min`/`max`/`step`, clamped via `clampPages` on blur), bound to the existing
      `maxPages` state that already flows to the engine clamp.*
- [x] **Verify**: re-run reproduces a batch (same URLs / options → new runs, compare works); a crawl with
      an exclude pattern omits matching URLs and keeps the rest; an invalid pattern → structured 400;
      tests green.
      *Verified for real against a production `next start` build. **Re-run:** a live `example.com` batch
      (mobile · runs 1 · [performance, seo]) scored `perf 100 / seo 80`; re-submitting it with
      `priorBatchId` produced a second batch with the **identical** scores + identical persisted options,
      the SSR `/batches` page rendered the **"re-run of <prior>"** lineage chip on the re-run's card, and
      `/api/history` carried both runs (grouped by URL for compare/trend). `GET /?watch=<id>` returned 200
      and rendered the live console. **Crawl exclude:** discovering the local app (depth 1) returned
      `/ · /history · /compare · /batches`; adding `excludePaths:["/history"]` returned exactly the other
      three; `excludePaths:["   "]` → **HTTP 400** `{code:"invalid_request", issues:[{path:"excludePaths.0",
      …}]}`. Lint, typecheck, build, and **345 unit tests** all green (Phase 13 added the
      exclude-matcher/schema, `priorBatchId` pass-through, queue-lineage, and `HistoryRow.options` tests).*

### Phase 14 — Scheduled daily archive
**Why:** swing's "Daily archive" / Archive tab — recurring re-runs with a browsable history. Largest
effort; the only phase that adds architecture (a *local* scheduler, consistent with §5's "single-user,
no Redis / cron" rationale).

- [x] **Schedule model**: a `schedules` table (target = a saved URL set *or* a crawl spec, + audit
      options + cadence e.g. daily @ HH:MM + enabled flag) with a Drizzle migration (self-healing like
      Phase 4).
      *Done: `schedules` (`src/lib/db/schema.ts`) carries `id`/`name`/`enabled`/`cadence`/`time`/`urls`/
      `crawl_spec`/`options`/`concurrency`/`device`/`accuracy_mode`/`last_fired_at`/`last_batch_id`/
      `created_at`/`updated_at`; the target is either a URL list (`urls` JSON non-null) or a crawl spec
      (`crawl_spec` JSON non-null). Migration `0003_sharp_professor_monster.sql` adds the table **and**
      a nullable `batches.schedule_id` so the Archive view can group batches by schedule (self-healing
      on first DB access via the Phase-4 runtime migrator). The seam types are in
      `src/lib/schedules/types.ts` (`Schedule`, `CreateScheduleInput`, `ScheduleTarget`, `isValidTime`)
      and the never-throwing persistence layer is `src/lib/db/schedules.ts` (`createSchedule`,
      `updateSchedule`, `recordScheduleFire`, `deleteSchedule`, `getSchedule`, `listSchedules`).*
- [x] **Local scheduler**: a `globalThis`-pinned singleton (same HMR-safe pattern as `AuditQueue` / the
      DB client) that, on cadence, submits the saved target through the existing queue — no external
      cron / Redis, runs offline.
      *Done: pure unit-tested cadence math (`src/lib/schedules/cadence.ts` → `shouldFireNow`/
      `nextFireAt`/`lastDueMoment`; daily semantics: not-yet-fired ⇒ due once `now ≥ lastDueMoment`;
      already fired ⇒ wait until the next cutoff) drives a tiny tick singleton
      (`src/lib/schedules/scheduler.ts`, `getScheduler()` pinned to `globalThis`) booted from
      `src/instrumentation.ts` (Next 16 startup hook, Node-runtime only, no-op in vitest via
      `LH_SCHEDULER_DISABLED=1`). The scheduler ticks once a minute; each fire resolves the target
      (URL list direct, or re-runs `discover()` for a crawl spec), submits via the unchanged
      `getAuditQueue().createBatch({ …, scheduleId })`, and calls `recordScheduleFire`. `scheduleId`
      threads through `CreateBatchInput` → `Batch` → `recordBatch` → `BatchInfo` (lineage only, never
      affects execution). `fireSchedule` never throws, so a broken schedule can't poison the loop.*
- [x] **Archive view** (`/archive`, new nav tab): list scheduled targets + their run history over time,
      reusing the Phase-6 trend / compare helpers for day-over-day deltas; create / pause / delete
      schedules here and via a "save as daily" affordance on the New-Audit form.
      *Done: SSR `/archive` (`src/app/archive/page.tsx`, mirrors `/history/page.tsx`) reads
      `listSchedules()` + `listBatches()` and renders a client `ArchiveConsole`
      (`src/components/archive/archive-console.tsx`) — one card per schedule with a telemetry strip
      (Cadence · Next run · Last run · Total runs), per-card actions Run now / Pause / Enable / Delete
      (POST `/api/schedules/:id/run`, PATCH/DELETE `/api/schedules/:id`, `router.refresh()` after each),
      and a dense per-`scheduleId` run-history strip. A new shadcn `SaveScheduleDialog` is wired into
      `new-audit-form.tsx` as the "Save as daily" affordance (next to Match DevTools), seeded with the
      form's current state (urls/options/concurrency/device/accuracyMode); the dialog captures name +
      HH:MM and POSTs `/api/schedules`. The `site-header` gained an "Archive" nav entry. The visual
      identity is preserved verbatim — dark cards with hairline borders, uppercase mono telemetry, no
      new colours/fonts. **Deviation:** the form's "Save as daily" persists the resolved URL list (a
      `urls` target), not the underlying crawl spec, when the user is on the Crawl tab — the
      `CrawlPanel` doesn't currently expose its spec upstream and lifting it is out of scope for this
      phase. The schedule shape (and `parseCreateScheduleBody`) already supports `crawl` targets so a
      future iteration can offer "save crawl spec" without a schema change.*
- [x] **Verify**: a schedule fires on cadence (fast-forwarded clock in test) → persisted batch; the
      Archive view shows its run history + day-over-day trend and survives a dev HMR reset;
      lint / types / build / tests green.
      *Verified for real against a production `next start` build. **Fast-forwarded clock:** the
      scheduler test suite (`src/lib/schedules/scheduler.test.ts`, 9 tests) drives `tick(now)` directly
      with synthetic `Date`s and asserts a due schedule fires + records `lastFiredAt`/`lastBatchId` +
      creates a batch carrying `scheduleId`; a second tick within the same cycle is a no-op; a
      disabled schedule is skipped; an empty-URLs crawl target and a sibling-fire failure are isolated;
      `runNow` succeeds and 404s on unknown id. **Live end-to-end:** `POST /api/schedules`
      (`time:"09:00"`, target `https://example.com`, perf+seo, mobile · simulated · 1 run) created
      schedule `h4GrAlDxrhRPW5DDXIn0C`; `POST /api/schedules/:id/run` force-fired it, producing batch
      `8Vs5WCjtzwyAPn_aG-epY` with `scheduleId` set, scores `perf 100 / seo 80` (identical to the
      Phase-13 example.com baseline); the schedule's `lastFiredAt` + `lastBatchId` updated; SSR
      `/archive` rendered "Daily example.com" with Run now / Pause / Schedule controls. PATCH disable
      → re-enable round-tripped; an invalid `"25:99"` time returned HTTP 400 `{code:"invalid_request",
      issues:[{path:"time", message:"time must be HH:MM (24h)."}]}`; DELETE returned 204 and the
      schedule was gone. **HMR survival:** the scheduler is the same `globalThis`-pinned singleton
      pattern that `AuditQueue` / `getDb` already use (and which Phase 4 verified survives HMR);
      `instrumentation.ts` is the official Next 16 boot hook and re-running it is a no-op by
      construction. Lint, typecheck, build, and **394 unit tests** all green (Phase 14 added 49 new
      tests — 11 cadence, 29 schedules-schema, 9 scheduler).*

---

> **Design constraint for Phases 15–16 (binding for all agents):** these are a *persistence-UX* pass, **not
> a redesign and not new architecture**. Reuse the existing seam — the `localStorage` active-batch pointer,
> the typed `auditClient` + `useBatchStream` reconnect path, and the `src/lib/db/persistence.ts` layer
> (`runs`/`batches` tables + report files). **Do not** introduce a client state library (Zustand / Redux /
> React Query) or a localStorage *result blob* — the database is the source of truth; the URL/`localStorage`
> only carries the batch *id*. The dark "precision-instrument" identity is preserved verbatim (no new
> colours / fonts / surfaces). Per CLAUDE.md, the UI work in Phase 16 MUST invoke **frontend-design** +
> **vercel-react-best-practices** + **shadcn**, then review with **web-design-guidelines**.

### Phase 15 — Persist completed results across navigation
**Why:** a completed run's results live only in `useBatchStream` React state inside `AuditConsole`
(`src/components/audit/audit-console.tsx`) and `PageSpeedConsole`
(`src/components/pagespeed/pagespeed-console.tsx`); on a route change the console unmounts and the result is
destroyed. The *only* thing kept across navigation is the active batch **id** in `localStorage`
(`lh:activeBatchId` / `lh:activePsiBatchId`) — and on completion both consoles deliberately delete it
(`audit-console.tsx:86`, `pagespeed-console.tsx:72`) so a finished run won't reconnect, which is exactly why
returning to the page shows an empty form. While a run is *in flight*, navigating away and back already
restores correctly (the pointer survives, the queue still holds the batch, and the SSE stream replays a
snapshot). Since every run is already persisted to SQLite (`runs`/`batches`) + report files, the fix is to
**keep the pointer and rehydrate from the DB** — not to add a client store.

- [x] **Keep the pointer through completion**: remove the `localStorage.removeItem(ACTIVE_BATCH_KEY)` call
      from the terminal/completion `useEffect` in **both** `audit-console.tsx` and `pagespeed-console.tsx`,
      so the active-batch id survives until an explicit dismissal (Clear / Archive / new run). The existing
      reconnect `useEffect` (validate via `getBatch`, re-attach via `useBatchStream`) then restores the
      result on return. "Start a new run" already overwrites the pointer + resets `toastedFor` — no change.
      *Done: the `removeItem` is gone from each console's completion effect (the effect now only fires the
      one-shot completion toast); the pointer survives until an explicit dismissal (Phase 16) or a new run.*
- [x] **Suppress the duplicate completion toast on restore**: in the reconnect `useEffect`, inspect the
      `getBatch(stored)` result's `status`; when it is already terminal, seed `toastedFor.current = stored`
      before `setBatchId` so returning to a finished run does **not** re-fire the "Audit complete" toast. A
      run still running at reconnect must still toast on its eventual completion.
      *Done. **Deviation:** the PRD's literal inline `toastedFor.current = stored` inside the reconnect
      `.then` trips this repo's `eslint-plugin-react-hooks@7.1.1` React-Compiler `immutability` rule (it then
      flags every other ref mutation, incl. the untouched `handleSubmit`). The seed-then-attach logic was
      moved into a `useEffectEvent` (`onReconnect`, stable in React 19.2) — identical runtime behaviour, lint
      clean: a terminal restore is pre-seeded so it never re-toasts; a still-running batch is left unseeded.*
- [x] **Rehydrate from SQLite so results survive a server restart**: add
      `reconstructBatch(batchId): Batch | undefined` to `src/lib/db/persistence.ts` that assembles a *lite*
      `Batch` from the `batches` row + its `runs` rows (inverse of `recordRun`; reuse `safeParse` /
      `rowToEnvironment`, map each row → an `AuditJob` with a reconstructed `AuditResultLite` or `error`,
      recompute `counts` via the queue's shape, derive `device`). Note: `perRunScores` / `perRunEnvironments`
      are not persisted as columns, so a restart-restored run degrades gracefully without the variance /
      spread sub-detail (same-process restores via the in-memory queue are unaffected).
      *Done: `reconstructBatch` reads the `batches` row + its `runs` rows (ordered by `idx`), maps each
      settled row → an `AuditJob` (done → reconstructed `AuditResultLite`; error → `{message}`), derives
      `device` (`both` when mobile+desktop present), recomputes `counts`, and threads `priorBatchId` /
      `scheduleId` / `source`. Lossy-by-design fields (`perRunScores`/`perRunEnvironments`, opportunities,
      BP breakdown) come back empty; the detail sheet's per-run-spread now also guards on
      `perRunScores.length > 0` so a restored run renders cleanly. Never throws.*
- [x] **Wire the DB fallback into the audit routes**: resolve snapshots as
      `getAuditQueue().getBatch(id) ?? reconstructBatch(id)` in **both** `src/app/api/audits/[id]/route.ts`
      (GET) and `src/app/api/audits/[id]/stream/route.ts` (the initial + the re-read snapshot). Because the
      stream route already sends a snapshot and closes for terminal batches, the existing client reconnect
      path restores DB-only runs **unchanged**.
      *Done: GET resolves `getBatch(id) ?? reconstructBatch(id)`; the stream route falls the `initial`
      snapshot back to `reconstructBatch(id)` (the re-read `current = getBatch(id) ?? initial` then carries
      the reconstructed batch, which is terminal → one snapshot + close). 404 semantics unchanged.*
- [x] **Verify**: run an audit on `/`, let it complete, navigate to History and back → results still shown;
      hard-refresh `/` → still shown; restart the dev server and refresh → results rehydrated from SQLite;
      repeat the whole flow on `/pagespeed`. Lint / typecheck / build / unit suite green — add a
      `reconstructBatch` round-trip test and a "route GET falls back to the DB after a queue miss" test.
      *Verified for real against a production `next start` build. **Restart survival (the core):** a live
      example.com audit (mobile · 1 run · perf+seo → `perf 100 / seo 80`, benchmarkIndex 3997) was then
      **killed-and-restarted**; `GET /api/audits/<id>` on the fresh empty queue returned **HTTP 200**
      reconstructed from SQLite (identical scores, `perRunScores: []` showing the documented degradation),
      and the stream route replayed a terminal `batch-snapshot`. **Browser (headless Chrome):** on `/` a real
      run kept its `lh:activeBatchId` after completion; a **hard refresh** re-rendered the full results table
      (100/96/92/80 + env badge) with **zero console errors**; **SPA nav to History and back** re-rendered it
      identically; the "Audit complete" toast fired **once on the run and zero on the restore**. The **whole
      flow repeated on `/pagespeed`** (own `lh:activePsiBatchId` key) — PSI scored `100/96/96/80`, the table
      restored on refresh, no duplicate toast, zero console errors. Lint, typecheck, build, and **459 unit
      tests** all green (Phase 15 added 4 `reconstructBatch` round-trip tests + 2 route-fallback tests).*

### Phase 16 — Archive & Clear dismissal controls
**Why:** with results now persisting across navigation (Phase 15), the user needs explicit ways to dismiss
them. Per the agreed model: **Archive** = remove from the console view but **keep** the run in History
(non-destructive); **Clear** = remove from the console **and delete** the batch from History (destructive);
**starting a new run** already replaces the shown result.

- [ ] **Terminal-state controls** in `src/components/audit/audit-results.tsx`: add `onArchive` / `onClear`
      props and render both buttons when the batch is **terminal** (alongside / replacing the existing
      `onCancel`, which shows only while a batch is queued/running), using only existing score-band tokens +
      Archivo / JetBrains-Mono (no new colours / fonts).
- [ ] **Archive (non-destructive)**: both consoles add `handleArchive()` → `setBatchId(null)`, remove the
      `localStorage` pointer, reset `selectedId` / `sheetOpen`. No backend call; the run stays in History.
- [ ] **Clear (destructive, confirmed)**: a console shows a whole **batch**, so delete batch-wide, not
      per-run. Add `deleteBatch(batchId): Promise<boolean>` to `src/lib/db/persistence.ts` (delete the
      batch's `analyses` → its `runs` rows → their report files → the `batches` row, mirroring `deleteRun`'s
      FK order and reusing `removeReportFiles`); add a batch-`DELETE` route under `src/app/api/history/…`
      and a `deleteBatch(id)` helper in `src/lib/client/auditClient.ts` next to `deleteRun`. `handleClear()`
      confirms via the existing destructive-confirm (AlertDialog) pattern from `history-table.tsx`, calls
      `deleteBatch`, then resets the console exactly like Archive.
- [ ] **Both engines**: apply the controls + handlers to `audit-console.tsx` and `pagespeed-console.tsx`
      (each keeps its own pointer key, so the two flows remember their own last result independently).
- [ ] **Verify**: after a completed run, **Archive** clears the console but the run remains on `/history`
      (and a refresh keeps the console empty); **Clear** (after confirm) removes it from the console **and**
      from History; a **new run** replaces a shown result. Repeat on `/pagespeed`. Lint / typecheck / build /
      tests green — add a `deleteBatch` test (removes the batch's runs + reports + analyses + batch row).

---

## 7. End-to-end verification strategy
1. **Engine correctness (Phase 1)**: CLI audit vs `npx lighthouse <url>` — scores within
   normal ±5 variance.
2. **Concurrency/reliability**: audit the same URL with N=3 median vs N=1; median is more
   stable. Confirm bounded concurrency is respected (no more than configured Chrome
   instances spawn).
3. **API (Phase 2)**: `curl` create-batch + SSE stream + result fetch.
4. **UI (Phase 3+)**: launch the app and drive a real multi-URL audit in the browser;
   confirm live scores, detail view, and HTML report open.
5. **Persistence (Phase 4)**: restart server, confirm history/reports survive.
6. **Crawl (Phase 5)**: discovered URLs match sitemap/links for a known small site.
7. **Compare (Phase 6)**: deltas/trends reflect a real before/after change.
8. **Parity (Phases 8–10)**: a URL run via the "Match DevTools" preset lands within a few points
   of the DevTools Lighthouse panel on the same machine; the reported `benchmarkIndex` matches the
   panel's "CPU/Memory Power", and accuracy mode removes concurrency-induced Performance deflation.
9. **Density & multi-device (Phases 11–14)**: at 1920 px the dense table shows many URL rows per
   screen with the table↔cards toggle persisting across reload; a `both` batch shows paired
   Desktop / Mobile pills; re-run reproduces a batch; a scheduled target fires and lands in the
   Archive — all with the existing visual design (palette / fonts / tokens) unchanged.
10. **Result persistence (Phases 15–16)**: after a completed Lighthouse/PageSpeed run, navigating away and
    back (and a hard refresh, and a server restart) keeps the results on the console; **Archive** dismisses
    the view while the run stays in History; **Clear** dismisses it and deletes the batch from History; a new
    run replaces the shown result.

## 8. Risks & mitigations
- **Score variability** → median-of-N default + document expected variance; surface
  per-run spread in the UI.
- **CPU contention skewing scores** → bounded concurrency (default 3) + explicit UI
  warning; recommend lower concurrency for trustworthy performance numbers. **Phases 8–10**
  harden this: an **accuracy mode** serializes Performance audits (concurrency 1) and a **drift
  warning** flags when a run's `benchmarkIndex` shows the host was over/under-powered or contended.
- **Scores not matching the DevTools panel / PageSpeed** → surface per-run `benchmarkIndex`, let
  users **calibrate** the CPU multiplier and pick the throttling method, and ship a **"Match
  DevTools" preset** (mobile · simulated · 1 run · concurrency 1) for a directly comparable run
  (Phases 8–10).
- **Lighthouse ESM / native `better-sqlite3` in Next bundling** → `serverExternalPackages`
  + Node runtime; dynamic import of `lighthouse` where needed.
- **Dev-mode HMR resetting the queue** → pin the singleton to `globalThis`.
- **Chrome not found / launch failure** → `chrome-launcher` auto-detects (Chrome is
  installed); add a clear preflight error if detection fails.
- **Density hurting readability / the established look (Phases 11–14)** → constrained to layout +
  tooling only (no palette / font / token changes); the dense table reuses the existing score-band
  colours and mono tabular figures, and true full-bleed keeps comfortable widths via dense
  table / grid structure rather than long prose lines. UI built with **frontend-design** and reviewed
  against **web-design-guidelines** before each phase is checked off.
