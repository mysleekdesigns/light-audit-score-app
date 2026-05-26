# PRD — Local Lighthouse Auditing Tool

> **Status:** Phase 2 complete — batch orchestration + API work end-to-end. An
> in-process `AuditQueue` (`p-queue` singleton on `globalThis`, bounded/configurable
> concurrency, `EventEmitter` progress) runs a batch of per-URL jobs and broadcasts
> `ProgressEvent`s; route handlers expose `POST /api/audits`, `GET /api/audits/:id`,
> `GET /api/audits/:id/stream` (SSE), and `GET /api/reports/:runId` (LHR JSON +
> `?format=html`), all with zod validation and structured error envelopes. **Key
> finding:** concurrent in-process `lighthouse()` calls collide on Lighthouse's
> process-global performance marks (`The "start lh:runner:gather" performance mark
> has not been set`), so each job now runs in its **own forked Node process**
> (`scripts/audit-worker.ts` via `runAuditInWorker`) — see the Phase 2 deviation note.
> Verified live: `curl` POST of a 3-URL batch at concurrency 3 streamed SSE progress
> and completed with **zero errors** (example.com 100/80, wikipedia 99/100, iana
> 81/92). Lint, typecheck, build, and 68 unit tests all green. Phase 1 (the headless
> engine + median-of-N + standalone CLI) remains complete underneath. Next up:
> **Phase 3 — Audit UI (paste list + live results)**.

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
- [ ] New Audit page: URL textarea (one per line / CSV), settings panel (device, runs,
      concurrency, categories) with the accuracy warning
- [ ] Live progress: per-URL cards (status, progress), category **score rings** (color
      thresholds 0–49 red / 50–89 orange / 90–100 green) + Core Web Vitals (LCP, CLS,
      TBT, FCP, SI, TTI)
- [ ] Results detail drawer/page: full metrics, opportunities & diagnostics, button to
      open the stored full HTML report
- [ ] SSE client hook with reconnect; toasts on completion/failure
- **Verify**: in-browser, audit a list of 3–5 URLs concurrently; scores/metrics render
      live and match Phase 1 CLI output.

### Phase 4 — Persistence & history
- [ ] Drizzle schema: `batches`, `runs` (per URL: scores, metrics, options, timestamp,
      report file paths); migrations via `drizzle-kit`
- [ ] Save median LHR as JSON **and** the Lighthouse HTML report to `./data/reports/`;
      index row in SQLite
- [ ] Wire queue → DB writes; serve stored reports via `/api/reports/:runId`
- [ ] History page: sortable/filterable table of past runs (by URL, date, score)
- **Verify**: run audits, restart the dev server, confirm history + reports persist and
      reopen correctly.

### Phase 5 — Site discovery (crawl + sitemap)
- [ ] `src/lib/crawl/discover.ts`: fetch `sitemap.xml` (+ sitemap index) via
      `fast-xml-parser`; optional shallow BFS crawl with `cheerio`, bounded by
      max-depth and max-pages, same-origin only, respect `robots.txt`
- [ ] New Audit UI: "Crawl a site" mode (domain + depth + max pages + sitemap toggle),
      preview/edit discovered URLs before auditing
- [ ] Feed discovered URLs into the existing batch queue
- **Verify**: crawl a small known site; discovered URL set is correct and audits run.

### Phase 6 — Comparison & trends
- [ ] Compare view: pick two runs of the same URL → score/metric diff (deltas, up/down)
- [ ] Trend sparklines per URL over time (shadcn charts / Recharts)
- [ ] Batch summary: averages, best/worst pages, pass/fail vs configurable thresholds
- **Verify**: audit one URL twice with a change between; diff and trend reflect it.

### Phase 7 — Polish & docs
- [ ] Export: download batch results as JSON/CSV; bulk-open reports
- [ ] Settings persistence (default device, runs, concurrency, score thresholds)
- [ ] Graceful handling: unreachable URLs, redirects, timeouts, Chrome launch failures
- [ ] Empty/loading/error states; keyboard & a11y polish
- [ ] `README.md`: setup, run, how scores are computed, accuracy notes
- **Verify**: full end-to-end pass — crawl → batch audit → history → compare → export.

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
