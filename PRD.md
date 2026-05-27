# PRD — Local Lighthouse Auditing Tool

> **Status:** Phase 7 complete — **the build is feature-complete.** The final polish landed:
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
> complete underneath. **All seven phases of §6 are done.**

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

## 8. Risks & mitigations
- **Score variability** → median-of-N default + document expected variance; surface
  per-run spread in the UI.
- **CPU contention skewing scores** → bounded concurrency (default 3) + explicit UI
  warning; recommend lower concurrency for trustworthy performance numbers.
- **Lighthouse ESM / native `better-sqlite3` in Next bundling** → `serverExternalPackages`
  + Node runtime; dynamic import of `lighthouse` where needed.
- **Dev-mode HMR resetting the queue** → pin the singleton to `globalThis`.
- **Chrome not found / launch failure** → `chrome-launcher` auto-detects (Chrome is
  installed); add a clear preflight error if detection fails.
