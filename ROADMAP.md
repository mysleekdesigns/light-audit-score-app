# ROADMAP — Competitive differentiation plan (Phases A–H)

> **Status (updated 2026-09-05):** **Phase A complete** — the Agentic Browsing category is
> live end-to-end (engine → SQLite → UI → PSI → AI analysis). Phases B–H are unbuilt.
> This file is a **plan**, not a record — it was drafted from a competitor survey of the
> free/local Lighthouse tooling space (Unlighthouse, Lighthouse CI, sitespeed.io,
> Lighthouse Parade) and the commercial monitoring tier (DebugBear, Foo.software,
> SpeedVitals, Treo). Sources are listed in §5.
>
> **Drive it with:** `/next-phase @ROADMAP.md` (next unfinished phase), or name one
> explicitly — `/next-phase @ROADMAP.md A`. There is no default plan file in this repo
> since `SAAS_PLAN.md` was retired (see `CLAUDE.md`), so the `@ROADMAP.md` argument is
> required.
>
> Each phase below carries a checklist and a **Gate** line. A phase is done only when its
> checklist is implemented, its Gate is green against a *real* run (not a proxy), the
> checkboxes are flipped with a short `*Done: …*` note in the PRD's house style, and the
> work is committed.

---

## 1. Positioning thesis

LightAudit Score's defensible position is the **intersection nobody else occupies**:

- **Unlighthouse** (MIT, ~195k downloads/mo) has the site-wide crawl, CI budgets and full
  auth support — but **no persisted history, no trends, no scheduling, and no AI**.
- **Foo.software** ($0–120/mo) has scheduled runs, trend history and Slack alerts — but it is
  a **hosted subscription** and your data lives on their servers.
- **DebugBear / SpeedVitals / Treo** have waterfalls, alerts, experiments, multi-location and
  RUM — all of it **SaaS**, all of it **their** AI.

Nobody — free or paid — offers **AI analysis running on your own local model, over your own
persisted audit history, on your own machine**. That intersection is the moat, and it is
currently under-exploited. Every phase below either (a) closes a table-stakes gap that keeps
people on Unlighthouse, or (b) widens the moat.

**The one-line pitch this plan builds toward:** *the local, private audit workbench that
scores your site for AI agents, remembers every run, and talks to your coding agent.*

### What we deliberately will NOT chase

- **Multi-location testing** (DebugBear: 30+ locations; SpeedVitals: TTFB from 40) — requires
  hosted infrastructure and contradicts the local-only model.
- **Real User Monitoring / RUM** — needs a hosted collector and a script on the customer's
  site. The CrUX field data already surfaced via the PSI engine is the honest local analogue.
- **No-code "experiments"** (DebugBear) — a proxy-rewriting product in its own right.
- Anything requiring a hosted account, a signup, or a bundled third-party application
  (see `CLAUDE.md` — the app ships no third-party application and stays vendor-neutral).

---

## 2. Competitive landscape (as surveyed 2026-09-05)

| Tool | Model | Has that we don't | Lacks that we have |
|---|---|---|---|
| **Unlighthouse** | Free, MIT, CLI + Vite UI | Auth (basic/cookies/headers/localStorage/programmatic login), `unlighthouse-ci` budgets + exit codes, static HTML report, CSV/JSON reporters, LHCI upload, dynamic-route sampling | Persisted history, trends, batch summaries, scheduling, AI analysis |
| **Lighthouse CI** | Free, Google | Assertions/budgets, PR comments + GitHub app, resource-level diff between two builds | Crawl/discovery, modern UI, AI, low-config start |
| **sitespeed.io** | Free, OSS, Docker | Video + visual metrics, HAR waterfall, CPU timeline, "the Coach" rules, real Android/iOS devices, Grafana/InfluxDB | In-app UI workflow, AI, SQLite-simple persistence |
| **Lighthouse Parade** | Free, OSS CLI | Crawl → one aggregated CSV row per page | Everything else |
| **DebugBear** | SaaS | Request waterfall, no-deploy experiments, Slack/Teams/email alerts with auto-detected regressions, side-by-side video compare, CI/CD + API + webhooks, public share links, RUM + CrUX | Local-only operation, your-own-model AI, free |
| **Foo.software** | SaaS $0–120/mo | Continuous scheduled runs, Slack threshold + **recovery** alerts, retained report history | Local-only, crawl, AI, free at any scale |
| **SpeedVitals** | SaaS | 30+ locations, TTFB from 40, batch-of-50, unused-resources/domain-map, weekly digest, competitor compare | Local-only, history you own, AI |
| **Treo** | SaaS | CrUX + Lighthouse in one view, sitemap scan, competitor benchmarking | Local-only, AI, free |

---

## 3. Phase order & dependencies

```
A (agentic browsing)  ─┬─────────────► F (CI budgets) ──► G (MCP server)
                       │
B (authenticated audits) ──────────────────────────────► (unblocks staging/logged-in work)
                       │
C (regression alerts)  │
                       │
D (waterfall + filmstrip) ──► E (audit-level diff) ────► H (client report export)
```

- **A** first: highest impact per unit of effort, and F's budgets should cover the new
  category from day one.
- **B**, **C**, **D** are independent of each other and of A — safe to interleave.
- **E** reuses the stored-report readers that **D** introduces.
- **G** reuses the programmatic/headless seam that **F** introduces.
- **H** wants **D** and **E** so the exported report is worth exporting.

---

## 4. Phases

### Phase A — Agentic Browsing category (Lighthouse 13.3+)
**Why:** Lighthouse **13.3 (released 2026-05-07)** added a fifth scoring category,
`agentic-browsing`, auditing how usable a site is to AI agents. This repo already has
**lighthouse 13.4.1** installed — `node_modules/lighthouse/core/config/agentic-browsing-config.js`
and the `agentic-browsing` entry in `default-config.js` are both present — but
`LIGHTHOUSE_CATEGORIES` in `src/lib/lighthouse/types.ts:19` still lists only the classic four,
so the category is invisible to the app. Cloudflare shipped an "Agent Readiness score" in
April 2026 and DebugBear shipped category support in May; Foo lists "AI search visibility" as
*in progress*. This is the fastest route to a headline nobody else in the free tier has, and
the engine work is close to zero.

The category's audits (per the installed config): `agent-accessibility-tree`,
`webmcp-form-coverage`, `webmcp-registered-tools`, `webmcp-schema-validity`,
`cumulative-layout-shift`, and `llms-txt`.

- [x] **Widen the category contract**: add `"agentic-browsing"` to `LighthouseCategory` and
      `LIGHTHOUSE_CATEGORIES` (`src/lib/lighthouse/types.ts`), which flows to
      `auditOptionsSchema`'s enum in `src/lib/lighthouse/options.ts` and every consumer of
      `CategoryScores`. Confirm the worker passes the category through untouched — the
      installed Lighthouse default config already scores it, so this should require no
      engine change beyond the enum.
      *Done: listed last, so every `LIGHTHOUSE_CATEGORIES`-ordered surface appends rather than
      reshuffles. The engine needed zero changes — `default-config.js` already declares the
      category AND its three gatherers (`WebMCP`, `WebMcpSchemaIssues`, `LlmsTxt`), and the
      worker parses its payload through `resolveAuditOptions`, whose enum is built from the
      widened list. `ScoreTrendPoint` was the one place that had hard-coded the four; it is now
      derived from `LIGHTHOUSE_CATEGORIES` so it cannot drift again.*
- [x] **Persist the fifth score**: add a nullable `score_agentic_browsing` column to `runs`
      (migration `0007`, self-healing on first DB access like `0001`/`0003`/`0004`); legacy
      rows degrade to `null` exactly as the Phase-10 environment columns do. Widen the
      `analyses.category` value set so the AI "explain & fix" flow can analyse it too.
      *Done: `drizzle/0007_abandoned_susan_delgado.sql`. Verified against the real 201-row
      database — the migration self-healed on first access and all 201 legacy rows read back
      `null`, none `0`. `analyses.category` needed no migration (free text validated against
      `LIGHTHOUSE_CATEGORIES` at the route), but the analysis PROMPT did: every scoring audit in
      this category carries weight 1, so "order fixes by impact" cannot discriminate — the prompt
      now orders by landing cost instead, and warns the model that the two INFORMATIVE WebMCP
      audits are weight 0, so recommending them as a way to raise the score is advice that
      provably cannot work.*
- [x] **UI**: a fifth score ring in the card view and a fifth pill column in the dense
      results table, reusing only existing score-band tokens + Archivo/JetBrains-Mono — the
      dark "precision-instrument" identity is preserved verbatim. Check the ring-grid and
      table breakpoints still hold at 5 columns. Add the category to the per-category pass
      thresholds in Settings and to the batch-summary pass/fail counts.
      *Done: short label `AGENT`, full label `Agentic Browsing`. Every 4-column breakpoint was
      re-cut for five (threshold dials, average-score rings, pass/fail grid, results table,
      detail sheet, history, compare). No new colour, font or token was introduced.*
- [x] **PSI honesty**: determine whether the PageSpeed Insights API accepts the new category.
      If it does not, hide or disable it on `/pagespeed` and badge the omission honestly
      rather than reporting a silent zero — the same honest-degradation rule the AI layer
      uses for `NO WEB RESEARCH`.
      *Done: **PSI accepts it — nothing needed hiding.** The v5 discovery document (revision
      `20260904`) lists `AGENTIC_BROWSING` in the `category` enum, and a live request for
      `https://web.dev/` returned it scored from PSI's own Lighthouse 13.4.1. Verified through
      our parser: `{"performance":43,"agentic-browsing":45}`, within ±5 of the local engine's
      46 on the same URL. A future PSI that dropped the category would parse to a missing
      score, never a silent 0.*
- [x] **Docs**: a Documentation chapter explaining what the category measures (agent
      accessibility tree, WebMCP tool/schema coverage, `llms.txt`, layout stability) and why
      it is scored separately, plus a README bullet.
      *Done: new chapter plus a README bullet, and the stale "four categories" claims elsewhere
      in the docs were corrected. The chapter is explicit about why the number is coarse, and
      the research behind that correctly went past the config to the audit sources: although all
      six `auditRefs` carry weight 1, `webmcp-registered-tools` and `webmcp-form-coverage`
      declare `scoreDisplayMode: INFORMATIVE`, so Lighthouse scores them at weight 0 and they
      cannot move the number at all. With not-applicable audits also dropping out of the mean, a
      typical page is scored on as few as two audits — so one flipping is worth 25 or 50 points.
      It also states that Google calls the category "under development and subject to change"
      and that pre-13.3 runs show `—` rather than 0.*
- [x] **Verify**: a live audit of a real site returns a non-null agentic-browsing score that
      matches the same URL run through the Lighthouse CLI at the same settings; the score
      persists, survives a restart, appears in History/Compare/Batches, and an AI analysis
      can be requested against it.
      *Done: `https://web.dev/` at mobile/simulated/cold scored **50** in the app and **50**
      from a direct `npx lighthouse` run taken minutes apart (delta 0). The row persisted as
      `84/90/100/92/50`, and an AI analysis of the new category ran end-to-end — the agent
      researched the Chrome agentic-browsing docs the prompt brief points it at.*

**Gate:** a live run of a real URL with all five categories selected persists five scores,
renders five rings and five pill columns with zero console errors, `/history` and `/batches`
show the new category, and the value is within ±5 of a direct `lighthouse` CLI run of the
same URL at the same settings.

*Gate green (2026-09-05).* `https://web.dev/`, mobile / simulated / cold cache, all five
categories: persisted `perf 84 · a11y 90 · bp 100 · seo 92 · agentic 50`; the batch summary
renders five rings, five threshold dials and a five-way pass/fail grid; `/history` shows five
pill columns (`84 90 100 92 50`); a direct `npx lighthouse` run of the same URL at the same
settings returned **50** — delta **0**. Eight pages driven under Playwright/Chrome reported
**zero** console errors. Also verified beyond the Gate: 201 pre-existing rows read back `null`
(never `0`), PSI returns the category through our own parser, and an AI analysis of it runs
end-to-end and persists.

*Security review (read-only `security-reviewer`, required because the diff touches the PSI key
path): **pass — no Critical or High**. It confirmed the diff leaves auth, the session token, the
request gate and the local server untouched, that the new column and export can hold only an
integer or NULL, and that prompt sanitisation is intact. Its one Medium was fixed here rather
than deferred: `buildPsiUrl`'s `apiKey` parameter carried a `= getPsiApiKey()` default, so an
explicit `undefined` — the obvious way to request a keyless URL — resolved the env key instead
of omitting it, making the module's "no env" docblock false and its tests silently dependent on
whether a key was set. The argument is now required, `runPsiAudit` is the single env reader, and
a regression test asserts no key appears even with `PAGESPEED_API_KEY` populated. The reviewer's
Low finding on CSV formula injection in `csvCell` is pre-existing, untouched by this phase, and
left for a future one.*

---

### Phase B — Authenticated & header-aware audits
**Why:** the single largest *functional* gap versus Unlighthouse, which supports basic auth,
cookies, bearer headers, localStorage seeding, query tokens and programmatic login. LightAudit Score
currently supports **none** — `grep` over `src/` finds no `extraHeaders`, no cookie jar, no
basic auth. This blocks the most common real job: auditing a staging environment or a
logged-in page.

**Security constraint (binding, per `.claude/rules/security.md`):** credentials are *not*
LightAudit Score's own secrets and **must never reach SQLite, a committed file, logs, or the client
bundle**. Per-batch credentials live in memory for the life of the batch and are **redacted**
from the persisted `runs.options` JSON. Long-lived values belong in `.env`
(`LH_AUDIT_BASIC_AUTH`, `LH_AUDIT_EXTRA_HEADERS`, `LH_AUDIT_COOKIES`), and Settings stays
read-only status plus guidance — never a key-entry form.

- [ ] **Extend the options contract**: add optional `extraHeaders`, `cookies` and `basicAuth`
      to `AuditOptions`/`auditOptionsSchema`, threaded to the forked worker. Lighthouse only
      runs in the forked worker (`.claude/rules/engine-workers.md`) — the credentials travel
      with the job payload, not through a module global.
- [ ] **Wire the engine**: map `extraHeaders` to Lighthouse's `extraHeaders` flag, `cookies`
      to the isolated Chrome profile before the navigation, and `basicAuth` to an
      `Authorization` header. Confirm interaction with `warmCache` (the warm-up navigation
      must carry the same credentials) and with the fresh `--user-data-dir` per run.
- [ ] **Redaction seam**: a pure, unit-tested `redactAuditOptions()` applied at every
      persistence boundary (`recordBatch`, `recordRun`, `recordFailedRun`), plus assertions
      that a credential value never appears in a stored report file, a log line, an SSE
      event, or an AI analysis prompt.
- [ ] **Crawl parity**: `src/lib/crawl/discover.ts` sends the same headers/cookies so
      discovery can walk a protected staging site, honouring the existing `robots.txt` and
      same-origin rules.
- [ ] **UI**: an "Authentication" disclosure in the audit control bar (header pairs, cookie
      pairs, basic-auth user/pass) that states plainly it is held for this batch only and
      never written to disk, with the `.env` route documented for values you reuse.
- [ ] **Security review**: run the read-only `security-reviewer` agent over the whole diff and
      resolve every Critical/High finding before the Gate is called green.
- [ ] **Verify**: a page that returns 401 unauthenticated is audited successfully with basic
      auth; a session-cookie-gated page scores like its public equivalent; a `grep` of
      `data/` (SQLite + report files) for the credential values finds nothing.

**Gate:** a real protected URL audits end-to-end with each of the three mechanisms; the
credential appears in no persisted artefact; `security-reviewer` reports no Critical/High.

---

### Phase C — Regression alerts on schedules
**Why:** Phase 14 built the whole daily scheduler and it notifies **nobody**. Foo.software
charges $20/mo for essentially "scheduled Lighthouse + a Slack message when a score crosses a
line, and again when it recovers"; DebugBear's most-quoted testimonial calls its alerts "our
early warning system". You already have schedules, persisted history and per-category
thresholds — the alert is the missing 10% that turns a finished feature into a monitoring
product.

**Security constraint:** a Slack/Discord webhook URL **is** credential-shaped, so it must come
from `process.env` (`LH_ALERT_WEBHOOK_URL`), never from `app_settings` and never from a UI
field. Non-secret preferences (enabled/disabled, which categories, the delta threshold) may
live in `app_settings`, consistent with the CrawlForge research switch.

- [ ] **Comparison core**: a pure, unit-tested module that takes a schedule's newest batch and
      its previous one and emits typed alert events — `crossed_below`, `recovered_above`,
      `dropped_by` — per URL and per category, using the existing threshold settings.
      Deliberately quiet: no event when nothing crosses.
- [ ] **Delivery**: a `POST` to `LH_ALERT_WEBHOOK_URL` with a Slack-compatible JSON body
      (plain-text fallback + the score deltas), fired from the scheduler after
      `recordScheduleFire`. Failure to deliver is logged and never fails the batch.
- [ ] **Per-schedule config**: `notify` fields on the `schedules` row (enabled, categories,
      minimum delta) — migration `0008`, self-healing — surfaced in the existing
      `EditScheduleDialog` and the `/archive` schedule card.
- [ ] **In-app surface**: an alert strip on `/archive` showing the last N alert events per
      schedule, so the feature is useful with no webhook configured at all.
- [ ] **Settings status**: Settings shows webhook **presence as a boolean** plus `.env`
      guidance — never the URL, never an entry field.
- [ ] **Verify**: a fast-forwarded-clock test proves fire → compare → alert, recovery
      alerting, quiet-when-unchanged, and that a delivery failure is isolated; then a live
      end-to-end fire against a local sink URL.

**Gate:** a real schedule fires twice against a URL whose score is forced to change, and both
the drop and the recovery alerts deliver, with the webhook URL absent from SQLite and logs.

---

### Phase D — Request waterfall & loading filmstrip
**Why:** the two features reviewers single out in DebugBear ("the most actionable-info packed
page speed visualization available… request-chain visualization") and sitespeed.io. For
LightAudit Score this is a **rendering job, not a measurement one**: the full Lighthouse JSON is
already persisted per run and already contains `network-requests` and `screenshot-thumbnails`
— neither audit id is read anywhere in `src/` today.

- [ ] **Report readers**: pure, unit-tested extractors that pull the `network-requests` table
      and the `screenshot-thumbnails` frames out of a stored report JSON, tolerating a missing
      or legacy audit (return empty, never throw) the way `reconstructBatch` degrades.
- [ ] **Waterfall view**: a new tab in the run detail sheet — one row per request (path,
      type, size, timing bars), sortable, with the render-blocking and third-party requests
      marked. Wide content scrolls inside its own container; existing tokens and monospace
      figures only.
- [ ] **Filmstrip**: the thumbnail frames on a timeline, with the LCP frame marked.
- [ ] **Lazy read**: report JSON is read on demand when the tab opens, not eagerly with the
      history row — a large report must not slow `/history`.
- [ ] **Verify**: waterfall and filmstrip render for a live run, for a *reconstructed*
      DB-only run, and degrade cleanly (empty state, no throw) for a legacy row whose report
      file predates the feature.

**Gate:** a real audit's waterfall row count and total transfer size match the same run
opened in the stored Lighthouse HTML report; the filmstrip frame count matches; zero console
errors; `/history` render time is unchanged.

---

### Phase E — Audit-level diff ("why did we drop 8 points?")
**Why:** Compare currently diffs category scores and Core Web Vitals only. Lighthouse CI's
most-loved capability is showing *which individual audits and resources* changed between two
builds. You already store both full reports, so this is UI over data you own — and it is the
feature that makes a score regression actionable in one click instead of a manual report diff.

- [ ] **Diff core**: a pure, unit-tested differ over two stored reports producing per-audit
      deltas (score, numeric value, wasted bytes/ms), classified as regressed / improved /
      unchanged / newly-present / disappeared.
- [ ] **Opportunity deltas**: rank by estimated savings change so the biggest regressions
      surface first; reuse the existing `Opportunity` shape.
- [ ] **Resource deltas**: added / removed / grown requests, built on the Phase-D
      `network-requests` reader.
- [ ] **UI**: a third card on `/compare` beside Trend and Diff, and a "what changed" entry
      point from a Re-run's lineage chip (`↻ re-run of <prior>`), which is the natural place
      a user asks the question.
- [ ] **Feed the AI**: pass the audit-level delta into the analysis prompt so the AI explains
      *the regression* rather than re-diagnosing the page from scratch — the single highest-
      value use of the existing analysis layer.
- [ ] **Verify**: two runs of a deliberately-changed local page produce a diff that names the
      exact audit that moved, and an AI analysis of that diff cites the change.

**Gate:** a real before/after pair on a locally-modified page yields a correct audit-level
diff (verified by hand against both stored HTML reports), and the AI analysis of the diff
identifies the introduced regression.

---

### Phase F — `lightaudit-ci`: budgets with an exit code
**Why:** Unlighthouse's entire CI pitch is one line — `unlighthouse-ci --site … --budget 80`,
exit 1 on failure — and Lighthouse CI's is assertions. LightAudit Score has per-category pass
thresholds in the batch summary but **no non-zero exit anywhere**, and `npm run audit` is one
URL with no assertions. This is cheap, and it is the difference between "a tool I open" and
"a tool in my pipeline".

- [ ] **Multi-URL CLI**: extend `scripts/audit-cli.ts` to accept a URL list, a file of URLs,
      or a crawl spec, reusing the *existing* `AuditQueue.createBatch` path — a new caller,
      not a new queue (the Phase-14 precedent).
- [ ] **Budgets**: `--budget <n>` (one threshold for every category) and per-category budgets
      from a config file, reusing the threshold shape Settings already persists. Exit 1 if
      any page fails any budget, exit 0 otherwise — that is the entire contract.
- [ ] **Reporters**: `--reporter json|jsonExpanded|csv` to stdout or a path, plus a static
      HTML summary, matching what CI users already expect from the incumbents.
- [ ] **Headless-safe**: no session token, no browser open, no server required — the CLI
      talks to the engine and SQLite directly. Runs must still persist to History so CI runs
      and UI runs share one archive (that shared archive is the differentiator).
- [ ] **Docs**: a README section with a GitHub Actions example, since that is how this feature
      gets discovered.
- [ ] **Verify**: a passing budget exits 0, a failing budget exits 1 and names the failing
      page + category, and both runs appear in the app's History afterwards.

**Gate:** a real two-URL CI invocation with a deliberately unreachable budget exits 1 with a
useful message; the same invocation with a reachable budget exits 0; both persist to History
and open in the UI.

---

### Phase G — LightAudit Score as an MCP server
**Why:** the widest part of the moat. Lighthouse MCP servers exist (danielsogl's, and Chrome
DevTools MCP now wraps Lighthouse), but they are **stateless single-page wrappers**. You have
an **audit history database**. Exposing LightAudit Score over MCP lets Claude Code or any agent
audit a page *during development* and compare it against months of your own baselines —
"did my change regress the page?" answered from real local history. Given the app is already
AI-native, this is the most defensible item on the list.

- [ ] **Server**: a stdio MCP server entry point (`scripts/mcp-server.ts`) run under the same
      native-TS invocation as the other scripts (never `tsx` — see README Requirements).
- [ ] **Tools**: `audit_url` (run and return scores), `get_history` (recent runs for a URL),
      `compare_runs` (Phase-E diff between two run ids), `check_budget` (Phase-F assertion,
      structured pass/fail). Keep the tool surface small and the payloads compact — an agent
      pays for every token of a Lighthouse report.
- [ ] **Reuse, don't fork**: the tools call the same queue, persistence and diff modules as
      the app. No second engine, no duplicated scoring.
- [ ] **Security**: the MCP server is a *local* process speaking stdio — it must not open a
      port, must not require or expose the session token, and must not read or forward any
      third-party credential. `security-reviewer` must review it before the Gate is green.
- [ ] **Docs**: a copy-pasteable `.mcp.json` / `claude mcp add` snippet, and a short
      "audit-driven development" walkthrough.
- [ ] **Verify**: a real Claude Code session adds the server, audits a local dev URL, reads
      that URL's history, and reports a regression against a stored baseline.

**Gate:** a live agent session drives all four tools end-to-end against a real local site;
`security-reviewer` reports no Critical/High; no port is opened and no token is required.

---

### Phase H — Client-ready report export
**Why:** exports today are JSON and CSV only. Freelancers and agencies auditing client sites
are a large, under-served audience that will never buy a DebugBear seat, and "run it locally,
hand the client a report" has **no free competitor** — Unlighthouse's static build is a
developer dashboard, not something you send to a client.

- [ ] **Static HTML export**: a self-contained single-file report for a batch — summary,
      per-URL scores, Core Web Vitals, top opportunities, and (from Phase D) the waterfall
      and filmstrip — with no external asset requests.
- [ ] **Print/PDF**: a print stylesheet that renders the same page cleanly to PDF from the
      browser, so no PDF library or headless-render step is added.
- [ ] **Light theme for print**: the dark "precision-instrument" identity stays the product's
      identity; the print sheet is a separate, ink-sane rendering of the same tokens.
- [ ] **Optional header**: a title/logo/date block filled from non-secret local settings, so
      the report can carry the auditor's own name. No third-party product names, no bundled
      assets.
- [ ] **Verify**: a real batch exports to a single HTML file that opens correctly with the
      network disabled, and prints to a legible multi-page PDF.

**Gate:** a real multi-URL batch produces a self-contained HTML file that renders fully
offline and prints to a clean PDF, with every score matching the in-app values.

---

## 5. Sources (surveyed 2026-09-05)

- Unlighthouse — <https://unlighthouse.dev/>, CI integration
  <https://unlighthouse.dev/integrations/ci>, authentication
  <https://unlighthouse.dev/guide/guides/authentication>
- Lighthouse CI — <https://github.com/GoogleChrome/lighthouse-ci>
- sitespeed.io — <https://www.sitespeed.io/>
- Lighthouse Parade — <https://github.com/cloudfour/lighthouse-parade>
- DebugBear — <https://www.debugbear.com/>, synthetic monitoring
  <https://www.debugbear.com/synthetic-website-monitoring>, agentic browsing category
  <https://www.debugbear.com/blog/lighthouse-agentic-browsing>
- Foo.software — <https://foo.software/lighthouse>
- SpeedVitals — <https://www.speedvitals.com/>
- Treo — <https://treo.sh/>
- Lighthouse agentic browsing scoring —
  <https://developer.chrome.com/docs/lighthouse/agentic-browsing/scoring>
- Cloudflare Agent Readiness score — <https://blog.cloudflare.com/agent-readiness/>
- Local evidence: `node_modules/lighthouse/package.json` (13.4.1),
  `node_modules/lighthouse/core/config/agentic-browsing-config.js`,
  `src/lib/lighthouse/types.ts:19`, `src/lib/lighthouse/options.ts`, `src/lib/db/schema.ts:87-91`
