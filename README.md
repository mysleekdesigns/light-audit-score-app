# Local Lighthouse Auditing Tool

A single-user, locally-run Next.js app for auditing the [Lighthouse](https://github.com/GoogleChrome/lighthouse)
scores of one or many URLs. It runs the audits on your machine, streams live progress, persists
every run, and lets you compare runs, view trends, and discover pages to audit.

## What it is

- Audit one URL or a whole list at once, with **live per-URL progress**: score rings, Core Web
  Vitals, and a drill-down report.
- **Persisted history**: every run is saved to local SQLite plus the full Lighthouse JSON/HTML
  report on disk, so history and reports survive restarts.
- **Comparison & trends**: per-URL score-trend charts and a two-run diff of category scores and
  Core Web Vitals.
- **Batch summaries**: averages, best/worst page, and pass/fail against configurable thresholds,
  with JSON/CSV export and bulk report opening.
- **Site discovery**: paste a URL list, or crawl a site (sitemap + shallow same-origin crawl,
  `robots.txt`-aware).

This is **local lab data only** — no PageSpeed Insights / CrUX field data. It uses the *same*
`lighthouse` engine (v13) that PageSpeed Insights runs, so the local scores are legitimate
lab measurements.

For the full design rationale and phased build history, see [`PRD.md`](./PRD.md).

## Requirements

- **Node.js v24+.** The Lighthouse engine and forked audit workers run under Node's native
  TypeScript type-stripping (`node ... script.ts`), **not** `tsx`. This is deliberate: `tsx`
  transpiles with esbuild's hardcoded `keepNames: true`, which injects `__name(...)` wrappers
  into Lighthouse source that Lighthouse then serializes and evaluates inside the browser page,
  where `__name` is undefined (`ReferenceError: __name is not defined`). Node's native stripping
  does no such transform. See the Phase 1 deviation note in [`PRD.md`](./PRD.md) §6.
- **Google Chrome** installed locally. `chrome-launcher` auto-detects the installed Chrome; each
  audit run launches a fresh, isolated headless instance.

## Setup

```bash
npm install
```

Database migrations are **self-healing**: the runtime SQLite client opens the database in WAL
mode and applies the committed `drizzle/` migrations on first access, so a fresh checkout
persists with no manual migrate step. You only need to regenerate migrations when you change the
Drizzle schema (`src/lib/db/schema.ts`):

```bash
npm run db:generate   # generate SQL migrations after a schema change
```

The local data directory `./data/` (the SQLite database plus generated reports under
`./data/reports/`) is **gitignored**; the `drizzle/` migrations are committed.

## Run

Development server:

```bash
npm run dev
```

Production build and start:

```bash
npm run build
npm run start
```

Standalone CLI (audit a single URL from the terminal, no UI):

```bash
npm run audit -- https://example.com
```

The `audit` script runs under `node --import ./scripts/alias-hooks.mjs scripts/audit-cli.ts`
(native TS + a tiny resolver for the `@/*` path alias) — **not** `tsx`, for the reason described
in Requirements above.

Quality gates:

```bash
npm test         # vitest (unit tests)
npm run lint     # eslint
npm run typecheck   # tsc --noEmit
```

## How to use

- **New Audit** — paste URLs (one per line / CSV) or switch to **Crawl a site** (domain + depth +
  max pages + sitemap toggle) to discover and preview pages before auditing. A settings panel
  exposes device, runs, concurrency, and categories, with an accuracy warning on high concurrency.
  Watch per-URL cards stream queued → running → done, with live category **score rings** and Core
  Web Vitals (LCP, CLS, TBT, FCP, SI, TTI), and open the stored full HTML report from the detail
  view.
- **History** — a sortable / filterable archive of every persisted run (by URL, date, score).
- **Compare** — groups history by URL: a per-URL score-trend chart + sparklines, and a two-run
  diff of category scores (higher is better) and Core Web Vitals (lower is better) with up/down
  direction.
- **Batches** — groups runs by batch and shows average scores, best/worst page, and pass/fail
  counts against configurable per-category thresholds, with JSON/CSV export and bulk report
  opening.
- **Settings persistence** — default device, runs, concurrency, categories, and per-category pass
  thresholds are remembered between visits.

## How scores are computed

- **Median of N runs.** Each URL is audited `N` times (default `N=3`, configurable 1–5). The
  median run is selected via Lighthouse's `computeMedianRun`, and its scores/metrics are surfaced.
  Runs are executed **sequentially** within a job — concurrent runs contend for CPU and distort
  timings.
- **Fresh isolated Chrome per run.** Every run launches its own headless Chrome (`--headless=new`)
  with a unique temporary `--user-data-dir` (cold cache), and always tears it down afterwards,
  even on error.
- **Categories.** Performance, Accessibility, Best Practices, and SEO (Lighthouse v13 — PWA was
  removed). Lighthouse reports each as 0–1; we normalise to **0–100** (rounded).
- **Colour bands.** 0–49 = poor (red), 50–89 = average (orange), 90–100 = good (green).
- **Configurable levers.** Form factor (**mobile** default / desktop — desktop uses Lighthouse's
  `desktopConfig`), throttling method (**simulated** default / applied — mapped to Lighthouse's
  `simulate` / `devtools` `throttlingMethod`), and the **CPU slowdown multiplier** (default = let
  Lighthouse pick its own **4×**). These are the biggest score levers — see *Calibration & DevTools
  parity* below for when and how to change them.

## Accuracy notes

- **Scores vary even on identical runs** — Lighthouse scores fluctuate by roughly ±5 points run to
  run, largely because Total Blocking Time (a CPU-sensitive metric) is about 30% of the
  performance score. The median-of-N default exists to dampen this variance; lower `N` is faster
  but noisier, higher `N` is more stable but slower.
- **Keep concurrency low for trustworthy numbers.** The queue runs with bounded concurrency
  (default **3**, capped at **8**). High concurrency on a single machine causes CPU contention
  that distorts performance scores. The UI warns about this; for the most trustworthy performance
  numbers, run at low concurrency.
- **Each job runs in its own forked process.** Lighthouse stores its `lh:runner:*` performance
  marks in process-global state, so two concurrent in-process `lighthouse()` calls corrupt each
  other. To get real, safe concurrency, the queue forks an isolated Node process per audit job
  (`scripts/audit-worker.ts`, under the same launcher as the CLI), each running its own sequential
  median-of-N for one URL. This is how concurrency is achieved without runs poisoning one another.

## Calibration & DevTools parity

Local lab scores are only comparable to the Chrome DevTools Lighthouse panel — or to a real
phone — when the **host machine** matched what the throttling targeted. The biggest hidden gap is
not the throttling *method*; it's that CPU throttling is expressed *relative to your host*. This
section explains how to read and close that gap. (For the full rationale see [`PRD.md`](./PRD.md)
§3's host-parity finding and §6 Phases 8–10.)

### benchmarkIndex ("CPU/Memory Power") and the 4× default

Every run records a **`benchmarkIndex`** — Lighthouse's "CPU/Memory Power" score for the machine it
ran on (higher = faster host; an Apple-Silicon Mac lands around ~4000, a high-end desktop ~1750).
Lighthouse's default **4× CPU multiplier** is *not* an absolute "mid-tier phone" setting: it is tuned
so a **high-end desktop** (benchmarkIndex ≈ 1750) lands on the **mid-tier mobile** target. On a
*faster* host, 4× under-throttles, so Performance reads optimistically; on a *slower* or
over-multiplied host it reads pessimistically. This is why the same site can score differently across
machines even with identical settings.

### The Calibrate workflow

The **Calibrate** button on the New Audit form re-targets mid-tier mobile for *your* host. It reuses
the latest completed run's `benchmarkIndex` (no separate benchmark pass), maps it to a device class,
and recommends a `cpuSlowdownMultiplier` of `round(benchmarkIndex / 437.5)` — the anchor that
reproduces Lighthouse's own bracket table (high-end desktop → 4×, high-end mobile → 2×, mid-tier
mobile → 1×). The recommendation is clamped into the engine's allowed band and persisted as your
default. So: run once, click Calibrate, and subsequent runs throttle to *mid-tier mobile from this
machine* rather than from a hypothetical high-end desktop.

### "Match DevTools" preset

The **Match DevTools** button makes a run directly comparable to the DevTools Lighthouse panel on the
same machine. It sets **mobile · simulated throttling · 1 run · concurrency 1 · accuracy mode on**,
and **resets the CPU multiplier to Lighthouse's own 4×** (clearing any calibrated value) — because
the panel itself uses simulated throttling with a constant 4× by default. Use this when you want to
reconcile a local number against DevTools; use Calibrate when you want the *most representative*
mid-tier-mobile number for your hardware instead.

### Simulated vs applied throttling

- **Simulated** (default) — Lighthouse runs the page **once, unthrottled**, then *estimates* throttled
  metrics from that single trace (the "Lantern" model). It's fast, low-variance, and matches what the
  DevTools panel and PageSpeed Insights do by default. Pick this for comparability.
- **Applied** (`devtools`) — Lighthouse applies **real** CPU and network throttling to Chrome *during*
  the run. It's slower and noisier, but closer to how a real throttled device behaves. Pick this when
  you specifically want measured-under-throttle behaviour rather than an estimate.

### Why concurrency affects Performance

Simulated throttling derives its entire estimate from that initial **unthrottled** trace. Running
several headless Chrome instances in parallel (the throughput default is **3**) makes them contend for
CPU *during that trace*, which inflates the measured TBT/LCP and therefore **deflates** the Performance
score versus a solo run. To get trustworthy Performance numbers, enable **accuracy mode**: it forces
*effective* concurrency to 1 whenever Performance is in scope (other URLs still queue), without
changing your configured `concurrency` for non-Performance work. Accessibility, SEO, and Best Practices
do not depend on CPU throttling and are unaffected by concurrency.

### Environment badge & drift warning

Each result card and the batch summary show an **environment badge**: the host's `benchmarkIndex` plus
the effective throttling method and CPU multiplier the run used. Alongside it, a **drift warning**
flags when a Performance score is likely distorted by the machine rather than by the page. It fires on
any of three signals:

- **Host-power drift** — the applied multiplier is far from what this host needs (e.g. a fast Mac left
  at 4×), with a one-click link to Calibrate.
- **CPU contention** — a wide `benchmarkIndex` spread across a batch's runs, meaning the host was busy
  or thermally throttling while some ran, so those scores are unstable.
- **Concurrency contention** — the batch ran at `concurrency > 1`, which depresses Performance as
  described above; the warning suggests an accuracy-mode (concurrency 1) re-run.

Drift only matters for Performance, so the warning is suppressed when Performance is not in scope.

## Architecture (brief)

- **Next.js App Router**, TypeScript, **Node runtime** (Lighthouse cannot run on the Edge
  runtime); audit-related route handlers are `runtime = "nodejs"` + `dynamic = "force-dynamic"`.
- An in-process **`p-queue` singleton** pinned to `globalThis` (HMR-safe) governs bounded
  concurrency and emits progress events streamed to the UI over **SSE**.
- Persistence via **`better-sqlite3` + Drizzle** (run/batch index) plus full report files on disk
  under `./data/reports/`.
- `next.config.ts` declares `serverExternalPackages: ['lighthouse', 'chrome-launcher',
  'better-sqlite3']` so these native/ESM-heavy packages are never bundled.

Key API routes (all Node runtime, `force-dynamic`):

- `POST /api/audits` — create a batch · `GET /api/audits/:id` — batch snapshot
- `GET /api/audits/:id/stream` — SSE progress stream
- `GET /api/reports/:runId` — stored LHR JSON (`?format=html` for the HTML report)
- `GET /api/history` — persisted runs · `POST /api/discover` — crawl/sitemap discovery

See [`PRD.md`](./PRD.md) §5 for the full architecture and the per-phase deviation notes.

## Project layout

```
src/
  app/
    api/            # route handlers: audits, audits/[id]/stream, reports, history, discover
    audit/ history/ compare/ batches/   # pages
  components/       # UI (audit, history, compare, batch-summary, shadcn/ui in ui/)
  lib/
    lighthouse/     # engine: runAudit, median-of-N, options/types, score parsing
    queue/          # p-queue singleton (AuditQueue) + forked-process worker runner
    db/             # Drizzle schema, client, persistence, report paths
    crawl/          # site discovery: robots, sitemap, BFS crawl
    compare/        # pure run-diff helpers
    batch-summary/  # pure batch averages / pass-fail helpers
    export/         # JSON/CSV exporters + download helpers
    settings/       # persisted audit defaults (device, runs, concurrency, thresholds)
scripts/            # audit-cli.ts, audit-worker.ts, alias-hooks.mjs
drizzle/            # committed SQL migrations (applied at runtime)
```
