# Local Lighthouse Auditing Tool

A single-user, locally-run Next.js app for auditing the [Lighthouse](https://github.com/GoogleChrome/lighthouse)
scores of one or many URLs. It runs the audits on your machine, streams live progress, persists
every run, and lets you compare runs, view trends, and discover pages to audit.

## Quick start

```bash
git clone https://github.com/mysleekdesigns/light-audit-score-app.git
cd light-audit-score-app
npm install
npm start
```

Then open <http://127.0.0.1:3000>. You need **Node.js v24+** and **Google Chrome** installed;
everything else is optional (see [Setup](#setup)).

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
- **Agentic Browsing score**: Lighthouse 13.3's fifth category — agent accessibility tree, WebMCP
  tool/schema coverage, `llms.txt`, layout stability — scored beside the classic four, on both the
  local and the PageSpeed engine.

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

### Environment

Copy `.env.example` to `.env` and fill in what you need — everything is optional:

```bash
cp .env.example .env
```

**PageSpeed Insights** (the `/pagespeed` page) calls Google's hosted API and needs an API key —
keyless PSI is now capped at a **0 daily quota** (instant HTTP 429). With a key you get the free tier's
25,000 requests/day (~240/min):

```bash
# .env
PAGESPEED_API_KEY=your-key-here
```

Two steps in the [Google Cloud Console](https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com):
**(1) enable the "PageSpeed Insights API"** on your project, and **(2)** create (or reuse) an API key on
that same project. If `PAGESPEED_API_KEY` is unset the engine falls back to `GOOGLE_API_KEY`, so one key
can serve both Custom Search and PSI — provided PSI is enabled on that key's project. The key is read
server-side only and never sent to the browser.

### AI analysis (optional)

After any Lighthouse or PageSpeed audit you can ask an AI *why* a category scored low and what to
change. It runs on **your** AI — LightAudit Score ships no AI credentials and nothing is preconfigured,
so pick a provider and set it up yourself.

**Claude Code (default).** If you already use Claude Code or Claude Max on this machine, there is
nothing to configure — analysis uses your existing login:

```bash
claude login    # once, if you aren't already signed in
```

This is the only path that can research the web and cite real sources, and it does so once you
give it a research server (see **Web research** below). Set `ANTHROPIC_API_KEY` instead if you'd
rather use an API key.

**Local model via [Ollama](https://ollama.com)** — private, free, works offline:

```bash
ollama pull qwen2.5-coder:14b
```

```bash
# .env
LH_ANALYSIS_PROVIDER=ollama
LH_ANALYSIS_MODEL=qwen2.5-coder:14b
```

Restart the server and open any finished audit. Settings → **AI analysis provider** detects a
running Ollama and lists your installed tags, so you don't have to remember them.

Model size matters here: a full Lighthouse audit is a lot of context to reason over.
`gpt-oss:20b` produced usable structured fixes in testing; `llama3.2` (3B) could not, and fell
back to a prose-only diagnosis. Prefer 14B and up with a large context window.

Local models can't browse the web, so their fixes are diagnosed from the audit data alone and
carry no citations — the UI badges this honestly as **NO WEB RESEARCH**. Small models sometimes
return prose instead of structured fixes; the analysis degrades to a diagnosis rather than
failing, and never invents a source.

**Any OpenAI-compatible endpoint** — OpenAI, OpenRouter, LM Studio, vLLM:

```bash
# .env
LH_ANALYSIS_PROVIDER=openai-compatible
LH_ANALYSIS_BASE_URL=https://api.example.com/v1
LH_ANALYSIS_MODEL=your-model-id
LH_ANALYSIS_API_KEY=your-key-here
```

**Web research (optional).** Claude can additionally look up current fixes on the web so each
recommendation cites a page it actually read. That needs a research MCP server, and the easiest
one to add is [CrawlForge](https://www.crawlforge.dev): get a free API key (1,000 credits, no
card), run `npx crawlforge-setup` once to store it, then switch it on under Settings →
**Web research**. It is off by default. When on, LightAudit Score launches a pinned
`npx -y crawlforge-mcp-server@<version>` on demand — the server reads the key from its own
setup file, LightAudit Score never touches it — and keeps the agent to CrawlForge's search and
page-reading tools, so one analysis costs a handful of credits rather than a crawl. To run a
newer CrawlForge release than the pinned one, set `LH_CRAWLFORGE_VERSION=x.y.z` in `.env`.

Any other MCP server with web-search and page-fetch tools works too: declare it as
`mcpServers.research` in `.mcp.json`, or point `LH_RESEARCH_MCP_CONFIG` at a config elsewhere.
With no research server, analysis still diagnoses from the Lighthouse data and is badged
**NO WEB RESEARCH**.

Keys are read from the environment at request time and never stored by the app. See
`.env.example` for every variable.

## Run

```bash
npm start        # or: pnpm start
```

That's it. On a fresh checkout `npm start` builds once (about a minute), then starts the app on
<http://127.0.0.1:3000> and opens it in your browser. Later starts skip the build and come up in
about a second.

The server runs audits on your machine, so it is locked to you: it binds **loopback only**, only
answers requests whose `Host` is a loopback name (so a web page can't reach it by DNS rebinding),
refuses state-changing requests from any other origin (including other ports on localhost), and
every route needs a per-install **session token**. `npm start` prints the token as a link —
`http://127.0.0.1:3000/?token=…` — and opens it; that one visit sets the session cookie, and the
token is kept in `data/session-token` so the link stays valid across restarts. Set
`LH_SESSION_TOKEN` (32+ characters) to pin your own, or `LH_OPEN_BROWSER=0` to skip the browser
(recommended on a shared machine, where a launching browser's command line is visible to others).

Override `PORT` and `HOST` if you need to. Binding beyond localhost is a deliberate choice, and
you then list the hostnames you will use in `LH_ALLOWED_HOSTS`:

```bash
PORT=4000 npm start
HOST=0.0.0.0 LH_ALLOWED_HOSTS=192.168.1.20 npm start
```

After changing source, rebuild explicitly (or use the dev server for hot reload):

```bash
npm run build    # rebuild once
npm run dev      # hot-reloading dev server instead
```

Standalone CLI (audit URLs from the terminal, no UI):

```bash
npm run audit -- https://example.com
```

The `audit` script runs under `node --import ./scripts/alias-hooks.mjs scripts/audit-cli.ts`
(native TS + a tiny resolver for the `@/*` path alias) — **not** `tsx`, for the reason described
in Requirements above. It takes several URLs, a URL file, or a crawl spec, and every run it does
lands in History alongside the ones you ran in the app. Give it a budget and it becomes a build
gate — see [CI: budgets with an exit code](#ci-budgets-with-an-exit-code).

Quality gates:

```bash
npm test         # vitest (unit tests)
npm run lint     # eslint
npm run typecheck   # tsc --noEmit
```

## CI: budgets with an exit code

The same engine runs as a build gate: **no server, no session token, no browser window** (Chrome
itself still launches — headless — because that is what an audit is). Give it some pages and a
bar. It exits **0** when every page clears it and **1** when one doesn't, naming the page and the
category so a red build is readable at a glance:

```bash
npm run ci -- https://example.com https://example.com/pricing --budget 90
```

```
✗ 2 budget violation(s) across 1 of 2 page(s):
  https://example.com/pricing [mobile]
      performance 71 < 90
      seo 88 < 90
```

Every CI run **persists to the same History as the app**, so a failed build opens next to the runs
you did by hand and can be compared against them. That shared archive is the point of running the
audit here rather than in a throwaway container.

### Targets

| | |
|---|---|
| `npm run ci -- <url> [<url> ...]` | one or more URLs (a bare host gets `https://`) |
| `--urls-file <path>` | one URL per line; blank lines and `#` comment lines ignored |
| `--crawl <seed>` | discover pages from a seed, bounded by `--max-pages`, `--max-depth`, `--no-sitemap`, `--no-follow-links`, `--exclude-paths=/admin,*.pdf` |

The audit dials are the ones `npm run audit` already takes — `--runs`, `--device=mobile|desktop|both`,
`--throttling`, `--cpu`, `--categories`, `--concurrency`, `--accuracy`. Run `npm run ci -- --help`
for the full list.

### Budgets

`--budget <n>` sets one bar for every category. `--config <path>` sets them per category, and wins
over the flag where both apply:

```json
{
  "budgets": {
    "performance": 90,
    "accessibility": 100,
    "seo": 90
  }
}
```

A category with no bar is reported and never fails the build, so adding a sixth Lighthouse
category can't retroactively break your pipeline. A page that could **not** be measured fails —
CI does not go green on the unknown. Budget only what you measure: a bar on a category
`--categories` doesn't run has no score to clear, and the CLI says so before it spends a minute
in Chrome.

### Reporters and exit codes

`--reporter json|jsonExpanded|csv|html` writes the report to stdout, or to `--output <path>`.
`json` is the format of record; `csv` opens in a spreadsheet; `html` is a self-contained page for
a build artifact. The verdict and the failing lines always go to **stderr**, so they survive
whichever reporter you pick — and with no `--reporter` at all you get the developer summary from
`npm run audit`.

| Exit | Meaning |
|---|---|
| `0` | every budget met |
| `1` | a budget violation, or an audit that failed to run |
| `2` | a usage error — bad flags, an unreadable config, no targets |

### GitHub Actions

LightAudit Score is distributed as source, so the job checks it out and runs it against your URLs.
`ubuntu-latest` already ships Google Chrome, which is all the engine needs.

```yaml
name: Lighthouse budgets

on: [push]

jobs:
  lighthouse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: mysleekdesigns/light-audit-score-app

      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - run: npm ci

      - name: Audit against budgets
        run: |
          npm run ci -- \
            https://example.com \
            https://example.com/pricing \
            --budget 90 \
            --reporter html \
            --output lighthouse-ci.html

      - name: Upload the report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: lighthouse-ci
          path: lighthouse-ci.html
```

Two notes on that workflow:

- `npm ci` (install dependencies) and `npm run ci` (audit) are different commands that happen to
  share three letters. The step names above keep them apart.
- History lives in `data/` under the checkout, which a runner throws away. Point `LH_DATA_DIR` at
  a cached or mounted directory if you want the archive to build up across runs.

## MCP: audits from your coding agent

The same engine once more, this time as an **MCP server** your coding agent drives while you
work: audit the page you just changed, then ask whether it regressed. Other Lighthouse MCP
servers are stateless single-page wrappers — they audit, they answer, they forget. This one is
backed by the local audit history, so "did my change make this worse?" is answered against runs
you already have, including the ones you did by hand in the app. The shared archive is the whole
difference.

### Setup

From this checkout:

```bash
claude mcp add lightaudit -- node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/alias-hooks.mjs ./scripts/mcp-server.ts
```

The same thing declared in `.mcp.json` (gitignored here — it is a machine-local file and is never
committed):

```json
{
  "mcpServers": {
    "lightaudit": {
      "command": "node",
      "args": [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--import",
        "./scripts/alias-hooks.mjs",
        "./scripts/mcp-server.ts"
      ]
    }
  }
}
```

Those relative paths resolve against the **agent's** working directory, not this one, so they only
hold when the agent starts inside the checkout. Anywhere else, spell both out in full —
`/path/to/light-audit-score-app/scripts/alias-hooks.mjs` and
`/path/to/light-audit-score-app/scripts/mcp-server.ts`. Verified against Claude Code 2.1.x, where
`claude mcp get lightaudit` reports `✔ Connected`.

It needs exactly what the rest of the app needs — **Node.js v24+ and Google Chrome** — and nothing
else: no server running, no session token, no port, no API key. The invocation is the native-TS
one described in [Requirements](#requirements), **not** `tsx`, for the same reason.

### The tools

| Tool | What it does | What it costs |
|---|---|---|
| `audit_url` | Runs a real Lighthouse audit and returns the category scores plus Core Web Vitals, with the `runId` it was archived under | headless Chrome, ~15–60s per run |
| `get_history` | Recent runs for a URL, or the most recent runs across every URL | a SQLite read; effectively free |
| `compare_runs` | The audit-level diff between two run ids — which audits moved, and what that did to the score | reads two stored reports |
| `check_budget` | Asserts an already-persisted run against a bar and returns structured pass/fail | a SQLite read |

`audit_url` takes `url` (required), `device` (`mobile` or `desktop`, default `mobile`),
`categories` (default: all five), and `runs` (1–5, **default 1**). That default is the one
deliberate divergence from the app, which takes a median of 3: an agent blocks on the call for as
long as the audit takes, so a single run is the sane default in a conversation. Pass `runs: 3`
when you want a number directly comparable to the app's. Every audit it runs lands in the same
History the app reads.

`get_history` takes `url`, `limit` (1–25, default 10), `device` and `status` — this is the tool
that finds you a baseline. `compare_runs` takes `baselineRunId` and `comparisonRunId`, bounded by
`maxAudits` and `maxOpportunities`; it returns that bounded projection and never the raw report,
because an agent pays for every token of a Lighthouse JSON.

`check_budget` takes either `runId` or `url` (the latest run for that page), plus `budget` (one
bar for everything) and/or `budgets` (per category). **Precedence runs the opposite way to most
config formats, and is worth reading twice:** the blanket `budget` is the floor and `budgets` is
the exception list, so `budget: 90` with `budgets: {"performance": 70}` reads as "90 everywhere,
except performance only needs 70". That is the same rule as the CI config, for the reason given
under [Budgets](#budgets) above. A budget that fails is a normal answer, not an error — the tool
reports the miss and the agent carries on with it.

### Audit-driven development

The loop, written as the things you actually type:

```
> Audit http://localhost:3000/pricing and give me the scores.
      audit_url — launches Chrome, archives the run, hands back a run id.

  … you make the change …

> Audit it again, then compare the two runs.
      audit_url, then compare_runs — which audits moved, and why the score did.

> How has that page trended this week?
      get_history — the stored baselines, app runs and agent runs alike.

> Can we ship it? 90 everywhere, performance only needs 80.
      check_budget — pass/fail against the run just persisted.
```

You describe the intent; the agent picks the tools. Because both halves write to the same archive,
a baseline you audited by hand in the app on Monday is a legitimate comparison point for a run the
agent does on Friday.

### Security

- It is a **local child process speaking stdio** — a pipe to whoever launched it. It opens no
  port, so there is nothing to reach.
- It requires **no session token**. The app's loopback gate protects an HTTP server; there is no
  HTTP here for it to protect.
- **The one outbound request it makes is the audit — to a URL the *agent* chose.** Worth stating
  plainly, because it is the difference between this and the CLI: you type the URL there, and here
  a model does, including a model that has been reading the web. There is no host allow-list, so
  loopback and private-network addresses are in range. The read-back is narrow — payloads carry
  scores, a final URL and audit ids, never a response body — so the exposure is what an audit
  *sends*, not what it returns.
- It holds **no credential of its own**, and it does not read `.env`. It takes only `LH_DATA_DIR`,
  `LH_DB_PATH` and `LH_MIGRATIONS_DIR` from that file — enough to share your archive, and nothing
  that authorises anything. So `.env` audit credentials (`LH_AUDIT_BASIC_AUTH` and friends) do
  **not** apply to an agent's audits unless you export those variables in the environment the
  agent itself was launched from. That is deliberate: the model picks the target, and an ambient
  credential it can aim at your staging host is one it can aim there on its own initiative.
- The audit runs in a forked worker that gets a **filtered environment** — the tool's own `LH_*`
  variables plus the process, locale, Chrome and proxy settings it needs, and nothing else. Your
  agent's provider API keys do not travel into the browser that renders the page being audited.
- It is **not read-only**, and that is the point: its audits write to the same local SQLite
  database as the app, so an agent adds rows to your History, and its runs show up in the UI
  beside your own.
- **Any agent you connect can read that whole archive.** `get_history` with no `url` returns
  your most recent runs whatever they were — every address you have audited, from the app as
  well as from the agent, staging and internal hosts included. That is what makes "compare this
  against your baselines" work, and it is worth knowing before you connect a server to a model
  that also reads the web.

### Traps

- **Which directory it runs from decides which archive it writes to.** Handled two ways, because
  one was not enough: the server anchors itself to the project root at startup, *and* it reads
  `LH_DATA_DIR` / `LH_DB_PATH` / `LH_MIGRATIONS_DIR` out of `.env` — which the app gets for free
  from Next, and a plain `node` script does not. Without that second half, following
  `.env.example` and setting `LH_DATA_DIR` would give you an app writing there and an agent
  writing to `./data` in the checkout: two histories, from doing exactly what the docs say. A real
  environment variable still beats the file.
- **Chrome still launches.** "No server" does not mean "no browser": `audit_url` starts a headless
  Chrome exactly like every other audit path here, and takes just as long.
- **`npm run mcp` is for launching it by hand**, to check that it starts and to read its stderr.
  You would not normally run it yourself — the agent launches it, and on your terminal it just
  sits waiting for JSON-RPC frames on stdin.

## How to use

- **New Audit** — paste URLs (one per line / CSV) or switch to **Crawl a site** (domain + depth +
  max pages + sitemap toggle) to discover and preview pages before auditing. A settings panel
  exposes device, runs, concurrency, and categories, with an accuracy warning on high concurrency.
  Watch per-URL cards stream queued → running → done, with live category **score rings** and Core
  Web Vitals (LCP, CLS, TBT, FCP, SI, TTI), and open the stored full HTML report from the detail
  view.
- **PageSpeed** — the same paste/crawl input, but audited by **Google PageSpeed Insights** (hosted
  Lighthouse, no local Chrome). Adds **real-world Core Web Vitals** from the Chrome UX Report (CrUX),
  shown per-URL and per-origin with distribution bars, alongside Google's lab scores. Reuses the same
  live results grid, History, and daily-schedule machinery as the local engine (PSI runs carry a
  cyan **PSI** badge in History).
- **History** — a sortable / filterable archive of every persisted run (by URL, date, score).
- **Compare** — groups history by URL: a per-URL score-trend chart + sparklines, and a two-run
  diff of category scores (higher is better) and Core Web Vitals (lower is better) with up/down
  direction.
- **Batches** — groups runs by batch and shows average scores, best/worst page, and pass/fail
  counts against configurable per-category thresholds, with JSON/CSV export and bulk report
  opening.
- **Documentation** — a built-in, beginner-friendly manual (21 chapters) covering setup, the audit
  dials, calibration, the Agentic Browsing category, AI analysis and providers, schedules, privacy
  and troubleshooting, with a scroll-spy contents rail.
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
- **Categories.** Performance, Accessibility, Best Practices, SEO, and **Agentic Browsing**
  (Lighthouse v13 — PWA was removed; `agentic-browsing` arrived in 13.3 and is scored by the
  *default* config, so it needs no custom config here). Lighthouse reports each as 0–1; we
  normalise to **0–100** (rounded).
- **Agentic Browsing is coarser than the rest.** Its score is the same weighted mean, but two of
  its six audits (`webmcp-registered-tools`, `webmcp-form-coverage`) are *informative* and carry
  weight 0, and audits that don't apply — no `llms.txt`, no registered WebMCP tools — drop out of
  the mean rather than scoring 0. On a typical site that leaves as few as two scoring audits
  (`agent-accessibility-tree` and `cumulative-layout-shift`), so one flipping moves the score up to
  50 points. Google's own report renders the category as a passed/applicable **fraction** rather
  than a percentage (`categoryScoreDisplayMode: 'fraction'`); we normalise the underlying score to
  0–100 like every other ring. Runs recorded before the column existed read back `null` and render
  as an em dash, never as 0.
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
do not depend on CPU throttling and are unaffected by concurrency; Agentic Browsing is affected only
through the `cumulative-layout-shift` audit it shares with Performance.

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
    ci/             # budgets, reporters + the headless batch seam the CLI and MCP share
    mcp/            # MCP server: JSON-RPC protocol, dispatch, and the four tools
    export/         # JSON/CSV exporters + download helpers
    settings/       # persisted audit defaults (device, runs, concurrency, thresholds)
scripts/            # audit-cli.ts, mcp-server.ts, audit-worker.ts, alias-hooks.mjs
drizzle/            # committed SQL migrations (applied at runtime)
```
