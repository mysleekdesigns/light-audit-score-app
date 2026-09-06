# ROADMAP — Competitive differentiation plan (Phases A–H)

> **Status (updated 2026-09-06):** **Phases A, B, C and D complete** — the Agentic Browsing category is
> live end-to-end (engine → SQLite → UI → PSI → AI analysis), audits can now authenticate
> (basic auth, cookies, headers) for both auditing and crawl discovery with credentials redacted
> at every persistence boundary, the daily scheduler finally notifies (an armed schedule
> compares each fire with the one before it and reports what crossed, in-app and to an optional
> webhook), and every run now opens a **Trace** tab: a request waterfall and a loading filmstrip
> read lazily from the report already on disk — data every audit has always captured and
> Lighthouse's own report never shows. Phases E–H are unbuilt. **E is next in dependency order**
> and is now unblocked, since it reuses D's stored-report readers; **F is independent of it.**
> D's `security-reviewer` pass came back clean (no Critical/High/Medium); its four Lows were fixed
> before the phase closed.
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

> *Added during the build, from the security review:* an `.env` credential is **ambient**, so it
> also needs a host allow-list — `LH_AUDIT_CREDENTIAL_HOSTS`, without which the three variables
> above are inert. Otherwise a credential set for one staging box rides along on every audit,
> and a batch of competitor URLs each receives it.

- [x] **Extend the options contract**: add optional `extraHeaders`, `cookies` and `basicAuth`
      to `AuditOptions`/`auditOptionsSchema`, threaded to the forked worker. Lighthouse only
      runs in the forked worker (`.claude/rules/engine-workers.md`) — the credentials travel
      with the job payload, not through a module global.
      *Done: `AuditOptions extends AuditCredentials`, validated by a shared `credentialShape`
      (also reused by crawl discovery) that enforces RFC 7230 token grammar on names and bans
      CR/LF/NUL — and `;` in a cookie value — so a header can never be forged from a field. They
      reach the worker over **IPC**, not in the fork's environment: a process environment is
      readable by anything running as the same user and inherited by every descendant, and this
      worker launches Chrome. `LH_AUDIT_INPUT` carries credential-free options plus an
      `awaitCredentials` flag; a real-fork test asserts the env holds neither the values nor even
      the header names.*
- [x] **Wire the engine**: map `extraHeaders` to Lighthouse's `extraHeaders` flag, `cookies`
      to the isolated Chrome profile before the navigation, and `basicAuth` to an
      `Authorization` header. Confirm interaction with `warmCache` (the warm-up navigation
      must carry the same credentials) and with the fresh `--user-data-dir` per run.
      *Done, with one deliberate deviation: cookies are serialised into a `Cookie` request header
      rather than seeded into the profile's cookie jar. Seeding would need our own CDP session
      between launch and Lighthouse's navigation, and would behave differently for the FRESH
      `--user-data-dir` a cold run creates than for the REUSED one warm-cache runs share. A header
      is identical under both. All three mechanisms therefore collapse to Lighthouse's single
      `extraHeaders` flag. `warmCache` verified rather than assumed: `median.ts` hands the same
      options to the discarded warm-up and to every measured run, and the fixture's request log
      confirms the warm-up authenticated — a 401'd warm-up would otherwise fill the reused profile
      with an error page and every measured run would score that.*
      **Known limitation, disclosed not hidden:** Chrome applies `extraHeaders` per PAGE, not per
      origin, so the credential rides every request the page makes, third parties included.
      Confining it would mean `Fetch.requestPaused` interception on every request, which distorts
      the timings this engine exists to measure. Stated instead in the Authentication panel, in
      `.env.example`, and in `buildCredentialFlags`.
- [x] **Redaction seam**: a pure, unit-tested `redactAuditOptions()` applied at every
      persistence boundary (`recordBatch`, `recordRun`, `recordFailedRun`), plus assertions
      that a credential value never appears in a stored report file, a log line, an SSE
      event, or an AI analysis prompt.
      *Done, and made structural as well as defensive. `redactAuditOptions` keeps header/cookie
      NAMES and replaces every VALUE — idempotent, so re-redacting never degrades the record — and
      runs at all three persistence boundaries. But the load-bearing change is that credentials
      never reach the `Batch` object at all: the queue holds them in a side map deleted when the
      batch settles or is cancelled, because `POST /api/audits`, `GET /api/audits/:id` and the SSE
      `batch-snapshot` all serialise the batch straight to the browser. Schedules **strip** rather
      than redact (a schedule fires days later with no batch in memory, so named-but-unsupplied
      credentials would be a lie). The report file needed its own fix: Lighthouse copies resolved
      settings into the LHR verbatim (`core/runner.js:112`), so `scrubLhrCredentials` nulls
      `configSettings.extraHeaders` in the worker — otherwise the value landed in
      `data/reports/*.json`, the HTML report regenerated from it, and the AI prompt built from it.*
- [x] **Crawl parity**: `src/lib/crawl/discover.ts` sends the same headers/cookies so
      discovery can walk a protected staging site, honouring the existing `robots.txt` and
      same-origin rules.
      *Done via `credentialedFetch`, shared by the seed/page, robots and sitemap fetches. It walks
      redirects by hand (`redirect: "manual"`), re-asking a per-URL resolver at every hop: the
      fetch spec strips only `Authorization`/`Cookie`/`Host`/`Proxy-Authorization` cross-origin, so
      a custom `X-Preview-Token` would otherwise be handed to whatever a staging host redirects to.
      An unauthenticated crawl takes the old single `redirect: "follow"` path unchanged. The gate
      is `isSameCredentialSite` — same host (`www.`-stripped), same port, with one relaxation: an
      `http:` scope may reach `https:` (upgrade yes, downgrade no), because a seed's http→https
      redirect is the common case and it moves the credential onto the safer transport.
      `canonicalize` now also strips `user:pass@` from discovered links.*
- [x] **UI**: an "Authentication" disclosure in the audit control bar (header pairs, cookie
      pairs, basic-auth user/pass) that states plainly it is held for this batch only and
      never written to disk, with the `.env` route documented for values you reuse.
      *Done: collapsed by default with a live status chip on the trigger (`Off` / `Basic +2` /
      `Check fields`), so a run that will authenticate never does so silently. State is plain
      `useState` — deliberately NOT `useAuditDefaults` (`localStorage`) or the draft
      (`sessionStorage`), with a comment on both sides so the inconsistency is not "fixed" later.
      One memoised resolution feeds the panel, the submit gate, the crawl request and the readout,
      so they cannot disagree. `run-config-card` gained an `Auth` cell reading NAMES only, which is
      why the same component renders the live draft and a persisted `batch.options` whose values
      are already `[redacted]`. No new colour, font or token.*
- [x] **Security review**: run the read-only `security-reviewer` agent over the whole diff and
      resolve every Critical/High finding before the Gate is called green.
      *Done — see the review note below the Gate.*
- [x] **Verify**: a page that returns 401 unauthenticated is audited successfully with basic
      auth; a session-cookie-gated page scores like its public equivalent; a `grep` of
      `data/` (SQLite + report files) for the credential values finds nothing.
      *Done against a purpose-built local site genuinely gated three ways, serving byte-identical
      markup behind each gate and behind a public `/open`, so a score difference could only come
      from the credential path. See the Gate note below.*

**Gate:** a real protected URL audits end-to-end with each of the three mechanisms; the
credential appears in no persisted artefact; `security-reviewer` reports no Critical/High.

*Gate green (2026-09-05).* Verified against a local site genuinely protected three ways — `/basic`
(401 without `Authorization`), `/cookie` (401 without a session cookie), `/header` (401 without
`X-Preview-Token`) — plus a public `/open` serving byte-identical markup.

- **Unauthenticated control fails**, which is what makes the rest mean anything: Lighthouse reports
  "the page could not be loaded". All three mechanisms then audit end-to-end through the real stack
  (HTTP API → queue → forked worker → Chrome → SQLite), each scoring **perf 100 · seo 100** —
  identical to the public equivalent, so the credential path changes access, not measurement.
- **No credential in any persisted artefact.** Zero hits for every secret — plaintext *and* its
  base64 basic-auth encoding — across the SQLite DB, its WAL, every stored JSON report, every
  regenerated HTML report, and the server log. What persists is provenance only:
  `{"basicAuth":{"username":"[redacted]","password":"[redacted]"}}`,
  `{"cookies":{"lh_fixture_session":"[redacted]"}}`,
  `{"extraHeaders":{"X-Preview-Token":"[redacted]"}}`. Nothing leaked into an API/SSE payload either.
- **The warm-up navigation authenticates**, confirmed from the fixture's own request log rather
  than inferred.
- **Crawl parity**, against a `sitemap.xml` that is itself gated: uncredentialed discovery returns
  only the seed with "No URLs found in sitemap"; credentialed discovery returns both URLs tagged
  `source: "sitemap"`, with zero warnings.
- **`.env` route**, all three states: credential set with no `LH_AUDIT_CREDENTIAL_HOSTS` → not sent,
  with a stderr warning naming the fix; host allow-listed → audits successfully; allow-listed for a
  *different* host → not sent. An env-authenticated run (no per-batch credential at all) persists
  its credential names, so it is never recorded as unauthenticated.
- **UI**, driven in real Chrome: the disclosure opens, the trigger chip flips to `BASIC`, the audit
  completes at `100/90/96/100/100`, the readout shows `AUTH · Basic`, and no secret appears in the
  rendered DOM. **Zero console errors.**

Suite: lint · typecheck · build · 909 tests, all green.

*Security review (read-only `security-reviewer`, required by the checklist): **pass** — no Critical,
and both High findings resolved before the Gate was called green.*

- **H1 — an `.env` credential was applied to every host audited or discovered, unscoped.** Real and
  serious: a `LH_AUDIT_BASIC_AUTH` set for a staging box would have been posted to all 30 hosts of a
  competitor batch. Fixed with a required host allow-list (`LH_AUDIT_CREDENTIAL_HOSTS`); an empty or
  missing list means NO host, never every host, and the misconfiguration that fails silently
  (credential set, no list) prints a one-shot warning naming the fix. The re-review attacked
  `matchesCredentialHost` over 21 cases — lookalike suffixes, apex-via-wildcard, `@`-userinfo host
  confusion, bare `*`, trailing dot — and every one fails closed. Verified live in all three states.
- **H2 — Chrome applies `extraHeaders` per PAGE, so the credential rides every request the page
  makes, third parties included.** Not fixed in code, deliberately: the only real fix is
  `Fetch.requestPaused` interception, which puts the Node process in front of every request and
  distorts the metrics this tool exists to report. Disclosed instead — mechanism, consequence and
  mitigation — in the Authentication panel, `.env.example`, and `buildCredentialFlags`. The reviewer
  accepted the trade on re-review.

Its Mediums were all fixed rather than deferred: an env-authenticated run recording no provenance
and rendering "Auth: None" (M1); credentials travelling in the fork's **environment**, which is
inherited by every descendant — including the Chrome process rendering untrusted content — now moved
to IPC (M2); and `canonicalize` keeping `user:pass@` in discovered links, which would have put a
password on screen and failed a whole batch (M3). Of its Lows, the silently-inert configs and the
one defence-in-depth regression the M2 fix introduced were also fixed: default-port and pasted-URL
allow-list entries now match (L4), IPv6 entries must be bracketed and fail closed otherwise (L5),
IPC credentials are re-validated on receipt (L6), a wildcard must keep two labels so `*.com` cannot
undo the allow-list (L7), and header maps are null-prototype so a header named `__proto__` is
recorded rather than silently dropped (L3). Two Lows are accepted as behaviour and left: re-running a
stored authenticated batch is refused with an explanation, since the values were never saved (L1),
and a credentialed `http://` seed is sent in cleartext without a warning (L2).

**Beyond the checklist:** a *fourth* credential channel that no slice owned — `https://user:pass@host`
— is now rejected by both URL schemas. Chrome would have authenticated with it, and unlike the other
three it was written down verbatim in `runs.url`, rendered in History, and used as the compare key.

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

- [x] **Comparison core**: a pure, unit-tested module that takes a schedule's newest batch and
      its previous one and emits typed alert events — `crossed_below`, `recovered_above`,
      `dropped_by` — per URL and per category, using the existing threshold settings.
      Deliberately quiet: no event when nothing crosses.
      *Done: `src/lib/alerts/compare.ts`, pure (no DB/queue/fetch import). Pairs runs by
      `(url, formFactor)` — a mobile drop is not a desktop drop — and emits at most ONE event per
      (url, device, category): a crossing is never also reported as a slide. The load-bearing
      decision is that **a missing score is silence, not zero**: a category absent, `null` or `NaN`
      on either side yields nothing, because treating a failed run as 0 would fire `crossed_below`
      on every category of every flaky night. A rise is only ever reported when it clears a bar the
      score was under. `minDelta` is defensively lifted off 0 — `prev - cur >= 0` is true for every
      **unchanged** category, the exact failure this module exists to prevent. Ordering is a
      property of the engine, not of config-writing order.*
- [x] **Delivery**: a `POST` to `LH_ALERT_WEBHOOK_URL` with a Slack-compatible JSON body
      (plain-text fallback + the score deltas), fired from the scheduler after
      `recordScheduleFire`. Failure to deliver is logged and never fails the batch.
      *Done, with the plan's timing clarified rather than followed literally: `recordScheduleFire`
      runs at FIRE time, when the batch has not audited a URL, so what happens there is **arming**,
      not sending. Two paths reach the evaluation because either alone has a hole — a queue
      subscription (immediate, but in-memory, so a restart loses it) and the minute-tick sweep
      (slower, but survives a restart). The URL never reaches a log line, an error message or a
      return value: `fetch` failures embed it in the cause chain and a 4xx body can echo it, so
      every path is reduced to a URL-free reason (`http 404`, `timeout`, `network error`), asserted
      by spying on `console.warn`.*
- [x] **Per-schedule config**: `notify` fields on the `schedules` row (enabled, categories,
      minimum delta) — migration `0008`, self-healing — surfaced in the existing
      `EditScheduleDialog` and the `/archive` schedule card.
      *Done: `drizzle/0008_powerful_silk_fever.sql`, purely additive (two nullable `ALTER TABLE
      ADD`s plus the `schedule_alerts` table). Rehearsed against a COPY of the real database before
      anything shipped: the migration self-heals on first access and the pre-existing schedule reads
      back `notify IS NULL` → `sanitizeNotify(null)` → **disarmed**. Upgrading the app can never
      start posting to a webhook on a schedule nobody armed.
      **One deviation worth recording:** the plan says the comparison uses "the existing threshold
      settings", but those live in `localStorage` (`useAuditDefaults`) — a scheduler firing at 03:00
      has no browser to read. Resolved by **seeding**: the Edit dialog copies the user's current
      Settings bars into the schedule's `notify.thresholds` when they arm alerts, and the schedule
      owns them from then on. That is also the better semantics — dragging a Settings dial to
      eyeball one batch must not silently re-arm alerts configured months ago.*
- [x] **In-app surface**: an alert strip on `/archive` showing the last N alert events per
      schedule, so the feature is useful with no webhook configured at all.
      *Done, backed by a real `schedule_alerts` table rather than recomputation — "the last N events"
      needs a record, and persisting it also means a delivery failure leaves evidence of what would
      have been sent (rows show `SENT` vs `IN-APP`). No new colour, font or token: kind maps to the
      existing bands (`crossed_below`→poor, `dropped_by`→average, `recovered_above`→**forced** good,
      since a category with a bar at 50 can recover into the average band and an amber recovery reads
      as a warning). `dropped_by` is distinguished without colour too — it prints no `bar N`, because
      there was none to cross. Three empty states, gated on the number of FIRES rather than of rows:
      "watching, nothing crossed" is a false claim for a schedule that has only fired once. The
      card's telemetry grid was re-cut for a fifth cell.*
- [x] **Settings status**: Settings shows webhook **presence as a boolean** plus `.env`
      guidance — never the URL, never an entry field.
      *Done: `GET /api/settings/alert-status` returns `{configured: boolean}` — byte-for-byte the
      `psi-status` shape, behind the same request gate, and its handler takes no `request` argument
      at all, so there is nothing to reflect. The panel contains **zero** input/form elements.*
- [x] **Verify**: a fast-forwarded-clock test proves fire → compare → alert, recovery
      alerting, quiet-when-unchanged, and that a delivery failure is isolated; then a live
      end-to-end fire against a local sink URL.
      *Done both ways. The suite grew 909 → 1039 tests, extending the existing fast-forwarded-clock
      harness rather than replacing it; live verification is the Gate note below.*

**Gate:** a real schedule fires twice against a URL whose score is forced to change, and both
the drop and the recovery alerts deliver, with the webhook URL absent from SQLite and logs.

*Gate green (2026-09-05).* Verified against a purpose-built local fixture whose score can be forced
to change deterministically — the lever is SEO (`<title>` + meta description present or absent),
because Performance varies run-to-run and a Gate must not depend on noise.

- **Three fires through the real stack** (HTTP API → queue → forked worker → Chrome → SQLite):
  baseline `seo 100`, forced regression `seo 82`, restored `seo 100`. The first fire was correctly
  **silent** (nothing to compare a baseline against); the second delivered
  `Crossed below · … SEO 100 → 82 (-18)`; the third delivered `Recovered · … SEO 82 → 100 (+18)`.
  Performance sat at 100 throughout and never spoke, and the three categories the run didn't select
  stayed silent rather than alerting on a `null`.
- **The webhook URL appears nowhere.** Zero hits for its host:port and a distinctive path sentinel
  across the SQLite DB (after a FULL WAL checkpoint), the WAL, the SHM, every stored report, and the
  server log — with a **control grep proving the method works** (the audited host is found 9× in the
  DB and 22× in the WAL). It is absent from the rendered Settings DOM too.
- **Quiet when unchanged**, live: a fourth fire with nothing altered delivered nothing and wrote no
  row.
- **A delivery failure is isolated**, live: with the sink killed, the batch still completed, the
  alert still persisted (`delivered = 0`, so the in-app strip keeps the record), and the log line was
  exactly `[alerts] webhook delivery failed: network error` — no URL.
- **UI driven in real Chrome**: the Archive card shows `ALERTS · Armed · 5/5 categories · ≥5pt` and
  the strip renders each event with its band-coloured before/after pair and `SENT` / `IN-APP`
  provenance. **Zero console errors.**

Suite: lint · typecheck · build · 1039 tests, all green.

*Security review (read-only `security-reviewer`, required by `.claude/rules/security.md` because the
phase introduces a credential-shaped env var, the app's first unsolicited outbound request, and a new
client-facing status endpoint): **pass — no Critical, no High.** Both Mediums and all four Lows were
fixed rather than deferred.*

- **M1 — duplicate webhook delivery.** The idempotence marker is written *after* delivery, so a
  minute tick landing inside a slow POST (up to the 10s timeout) re-evaluated the same batch and
  posted twice. Fixed with a claim taken **synchronously** before the first `await` and released in a
  `finally`. The marker deliberately still writes after delivery — a process killed mid-POST should
  retry, not lose the regression silently — so the Set covers the in-process race and the marker
  covers the restart. The regression test drives two concurrent ticks plus a direct re-evaluation
  against a held-open delivery; it was **confirmed to fail with the claim disabled**.
- **M2 — "Clear history" left audited URLs behind.** `clearHistory` deleted runs, batches and reports
  but not `schedule_alerts`, whose rows carry the audited URL and both scores and keep rendering.
  Someone clearing history to remove the record of what they audited did not get that. Alert rows are
  history, not config: they are now deleted with everything else, and each schedule's stale
  evaluation marker is nulled.
- **L1 — a hostile audited site could format an alert line.** A crawl target takes its URLs from
  links and sitemap entries on the site under audit, and `*`, `_`, `~`, a backtick and CR/LF all
  survive URL normalization — so `https://evil.example/*Nothing wrong here*` rendered bold in the
  user's channel, and an embedded newline forged an entire extra alert line. Fixed by
  percent-encoding those characters in the URL only, which is **lossless** (`%2A` is the same URL and
  still resolves) where a lookalike substitution would silently change the address the reader sees.
- Also fixed: an unconsumed failed-response body holding the socket (L2), `describeCounts` using `in`
  and so walking the prototype (L3), and `previousCompletedBatchId` not scoping its reference batch
  to the schedule (L4). The reviewer additionally caught a docblock my own M1 fix orphaned.

The reviewer confirmed the diff leaves untouched the request gate, `localGate.ts`, Phase B
audit-credential redaction, session-token resolution and the loopback binding, and that stored alert
rows are whitelisted on read and rendered as React-escaped text.

---

### Phase D — Request waterfall & loading filmstrip
**Why:** the two features reviewers single out in DebugBear ("the most actionable-info packed
page speed visualization available… request-chain visualization") and sitespeed.io. For
LightAudit Score this is a **rendering job, not a measurement one**: the full Lighthouse JSON is
already persisted per run and already contains `network-requests` and `screenshot-thumbnails`
— neither audit id is read anywhere in `src/` today.

- [x] **Report readers**: pure, unit-tested extractors that pull the `network-requests` table
      and the `screenshot-thumbnails` frames out of a stored report JSON, tolerating a missing
      or legacy audit (return empty, never throw) the way `reconstructBatch` degrades.
      *Done: `src/lib/reports/extract.ts` against the frozen contract in `types.ts`, pure in the
      `parseLhr` sense (whose narrowing helpers it reuses) — no I/O, no `lighthouse` import.
      Three things the real reports taught us, none of them guessable from the plan. **(1) `-1`
      is Chrome's "unknown", not a size.** One stored report carries a worker `blob:` request
      with `transferSize: -1`, and summing it naively put our total ONE BYTE below Lighthouse's
      own — a wrong number that looks right. Treated as unknown, our total now equals
      `total-byte-weight` and `resource-summary` exactly. **(2) Lighthouse 13 renamed the
      render-blocking audit** (`render-blocking-resources` → `render-blocking-insight`); both ids
      are read and unioned, so either era marks its rows. **(3) Third-party is a join, not a
      hostname guess:** `lhr.entities[].isFirstParty` keyed by the request's `entity`, falling
      back to origin comparison for legacy reports — which reproduces Lighthouse's own
      third-party count exactly (19 of 104 on the example.com report). Tolerance is shape-driven,
      not label-driven: an audit is read whenever `details.items` is an array, never by asserting
      `details.type`, precisely because Lighthouse has renamed things under us before.
      `unavailable` is load-bearing and distinct from an empty list — a page that genuinely made
      zero requests must not be reported as a report too old to have the data.*
- [x] **Waterfall view**: a new tab in the run detail sheet — one row per request (path,
      type, size, timing bars), sortable, with the render-blocking and third-party requests
      marked. Wide content scrolls inside its own container; existing tokens and monospace
      figures only.
      *Done: `request-waterfall.tsx` over a pure `waterfall-view.ts` (comparators, bar geometry,
      formatting, mark predicates), which is how a component gets unit-tested at all here —
      Vitest runs `environment: "node"` with no jsdom, and none was added. Sortable on order /
      start / duration / size, stable, with `index` preserved as row identity so a sort never
      loses the LHR's own ordering. Marks are the text badges `RB` and `3P`, not colour alone.
      **Deliberately no links:** routing 100+ attacker-chosen subresource URLs through
      `safeHttpHref` would still put 100+ attacker-chosen navigation targets in a modal's tab
      order, and Phase C's L1 finding is the standing reminder of what a hostile audited site
      does with a user-facing surface. The full URL is on hover instead. No new colour, font or
      token.*
- [x] **Filmstrip**: the thumbnail frames on a timeline, with the LCP frame marked.
      *Done: `loading-filmstrip.tsx` over a pure `filmstrip-view.ts`. Frames sit against a time
      axis with monospace per-frame timings and scroll in their own box — eight 96px thumbnails
      do not fit a 672px sheet — and a click enlarges one, because a 96px thumbnail of a whole
      page answers "something was painting" but not "what did the user actually see at 1.2s?".
      The LCP frame carries a text label, not just a colour.*
- [x] **Lazy read**: report JSON is read on demand when the tab opens, not eagerly with the
      history row — a large report must not slow `/history`.
      *Done, and this clause is why the whole data path is shaped as it is. Stored reports here
      average **~690 KB and reach 1.5 MB**, so the browser must never receive one: the extractors
      run server-side behind a new `GET /api/reports/:runId/trace`, which returns only the compact
      projection (**931,602 → 234,019 bytes** on the gate run, and the remainder is almost
      entirely the eight inline JPEG frames, which are irreducible). `useRunTrace(runId, active)`
      fetches nothing until the tab is opened and caches the result — a finished run's report is
      immutable, so a refetch could only return the same bytes. The pane is still `forceMount`ed
      like its siblings, which is not in tension with that: `active` gates the FETCH, not the
      mount, so the sort order and the enlarged frame survive a trip to Analysis and back. The
      route mirrors `GET /api/reports/:runId`'s degradation ladder (disk → in-memory queue → 404),
      with one deliberate difference — a report file that is PRESENT but unparseable returns a
      structured 500 rather than falling through, because an absent report is ordinary and a
      corrupt one is a real fault.*
- [x] **Verify**: waterfall and filmstrip render for a live run, for a *reconstructed*
      DB-only run, and degrade cleanly (empty state, no throw) for a legacy row whose report
      file predates the feature.
      *Done, all three driven in real Chrome — see the Gate note below.*

**Gate:** a real audit's waterfall row count and total transfer size match the same run
opened in the stored Lighthouse HTML report; the filmstrip frame count matches; zero console
errors; `/history` render time is unchanged.

*Gate green (2026-09-06).* Live audit of `https://web.dev/`, mobile / simulated / cold cache, all
five categories — `perf 85 · a11y 90 · bp 100 · seo 92 · agentic 46`.

- **Row count and transfer size match exactly.** Our `/trace` output versus a count taken
  independently — a script sharing no code with `src/lib/reports/`, reading the LHR that
  Lighthouse itself embedded in the stored **HTML** report: **97 requests = 97**, **2,448,959
  bytes = 2,448,959**. That byte total also equals Lighthouse's own `total-byte-weight` and its
  `resource-summary` total, computed by two more independent code paths. And the DOM agrees:
  **97 `<tr>` rows** counted in the rendered tab, not read back from our own API.
- **Filmstrip frame count matches: 8 = 8**, likewise counted as `<img>` elements in the DOM.
- **Zero console errors**, zero page errors, zero failed requests — across all three cases below.
- **`/history` render time is unchanged**, measured on the same machine either side of the change:
  **555,582 bytes and ~19 ms** before, **555,582 bytes and ~19 ms** after. Byte-identical, because
  the page's query never learned about reports.
- **The lazy read is proven, not asserted**: Chrome's own network log shows **0** requests to
  `/trace` before the tab is clicked and **exactly 1** after.
- **Reconstructed DB-only run**: after a full server restart (empty in-memory queue, batch rebuilt
  from SQLite by `reconstructBatch`), the same run renders identically — 8 frames, 97 rows.
- **Legacy report row**: a run whose stored report has both audits stripped — the on-disk shape of
  a pre-feature report — degrades to `unavailable: true` on both surfaces, with empty states that
  explain *why* ("this run was stored without a `network-requests` audit … re-run the audit to
  capture one") rather than merely that. No throw, no console error. The fixture was removed from
  the archive afterwards.

Suite: lint · typecheck · build · **1194 tests**, all green (1039 → 1194).

*Security review (read-only `security-reviewer`, required by `.claude/rules/security.md` because
the phase adds a route to the local HTTP server): **pass — no Critical, no High, no Medium.** All
four Lows were fixed here rather than deferred.* (Its report arrived only after a long delivery
delay, during which the checks listed further below were performed independently; the reviewer
also revised its own initial Medium down to Low on seeing the linearity data, noting the browser's
~6-connection-per-origin cap bounds the blind-fetch vector.)

- **L1 — the route re-read and re-parsed a ~690 KB report on every request, uncached and
  unbounded.** The parse is synchronous, so it occupies the event loop, and the route is reachable
  *blind* cross-origin: cookies ignore ports and `SameSite=Strict` is scoped to the site, not the
  port, so a page on another loopback port passes every gate check (a GET is in `SAFE_METHODS`, so
  `isTrustedWrite` never consults `Sec-Fetch-Site`) and CORS stops it reading the body but not
  causing the work. Notably this was *not* inherited posture — the sibling `/api/reports/:runId`
  passes the file through verbatim and never parses. Fixed with a 16-entry LRU memo plus an
  `fs.stat` ceiling (32 MB, ~20× the largest report observed) so an oversized file is never read
  into memory at all. Repeat reads went from a full 931 KB read+parse to **~3.4 ms**.
  **A second-order risk the fix introduced, caught here rather than shipped:** an in-process memo
  is exactly how a *deleted* run keeps serving its URLs, which is Phase C's M2 all over again. The
  DB lookup stays authoritative for existence and the memo only saves the expensive part, so
  deleting a run — or clearing history — evicts it; there is a regression test for precisely that.
- **L2 — the 200 body echoed the caller's raw `runId`.** Unexploitable (a 200 is only reachable for
  an id that already matched a row), but the route's own docblock promises the run id is never
  reflected, and the success path quietly undercut it. Now echoes the DB-round-tripped value.
- **L3 — the genuinely instructive one, and a gap in my own testing.** The waterfall's safety
  against display spoofing comes from WHATWG `URL`, not from any check of ours: it percent-encodes
  the path (U+202E → `%E2%80%AE`) and punycodes the host (a Cyrillic homograph → `xn--…`). The
  *fallback* branch — a URL too malformed to parse, where the raw string is shown — got none of
  that, and every URL in my hostile fixture parsed, so my Chrome test could not have caught it. A
  focused control/bidi strip now runs on `path`/`host`/`entity`/`resourceType`/`mimeType`, with the
  untouched original kept for the hover title. Verified live: `ht!tp://evil<RLO>gnp.exe` renders as
  `ht!tp://evilgnp.exe`, and zero displayed fields carry a bidi or control character. Deliberately
  *not* the reviewer's suggested `sanitizeUntrusted` — that one also defangs `<` and strips prompt
  guards, which is right for an LLM prompt and wrong for a URL (React escapes markup here, so
  defanging only corrupts a legitimate address), and it would couple this module to the analysis
  layer. Same threat, different output medium.
- **L4 — the filmstrip guard accepted any `data:image/`, including `svg+xml`.** Inert as written,
  but only while the URI reaches nothing but `<img src>` — a property of every *future* caller,
  which this module cannot enforce. Pinned to `data:image/jpeg;base64,`, which all 1,792 frames
  across the 224 stored reports already use, so the SVG-in-`img` semantics stop needing to be
  reasoned about.

The reviewer also confirmed, against the installed Lighthouse rather than by assumption, that the
filmstrip is capped at 8 frames and `data:` URLs are elided to ~100 chars — so the 234 KB payload
is not attacker-inflatable.

The checks below were performed directly while the report was outstanding, and stand as
independent corroboration:

- **Path traversal on the `runId` route parameter: fails closed.** Eight live payloads
  (`../../../../etc/passwd`, single- and double-encoded, `%00`, absolute, `....//`) all returned
  404 or a 308 normalise; none returned file content. Structural reason: `getRunReport(runId)`
  resolves the id through SQLite and builds the path from `row.id`, so caller input never reaches
  `path.join`.
- **No error-body reflection:** every failure path returns a static string with no id echoed.
- **No credential can ride the projection:** enumerating every key of a real 234 KB response gives
  exactly the frozen contract — there is no header field of any kind, so there is structurally
  nothing to leak; `authorization`/`bearer`/`set-cookie`/`extraHeaders`/`basicAuth`/`password` are
  all absent and no request carried `user:pass@` (which Phase B already rejects at both URL schemas).
- **A hostile audited site cannot reach the operator through the waterfall.** A report seeded with
  eight malicious request URLs (`<img src=x onerror=…>`, `<script>`, `javascript:`,
  `data:text/html`, an attribute breakout, a 4,000-char URL, an RTL override) was driven in real
  Chrome: no payload executed, 0 injected script or image elements, 0 `javascript:`/`data:text/html`
  hrefs, and no horizontal overflow. The payloads *are* on screen as escaped text — so the test did
  not pass by silently dropping them.
- **No amplification, recursion bomb, or prototype pollution** in the extractor: 100k requests
  (~1000× a real page) project in 77 ms / 31 MB, linearly; a 50,000-deep nested `details` is handled
  without a stack overflow; and `__proto__`/`constructor` keys in report data leave
  `Object.prototype` untouched. The route's per-request parse is the same exposure the pre-existing
  `GET /api/reports/:runId` already has, which serves the whole file.
- **Untouched**, confirmed by `git status`: `src/proxy.ts`, `src/lib/http/localGate.ts`,
  `reportCsp.ts`, `scripts/start.mjs`, `scripts/session-token.mjs`, `credentials.ts`,
  `persistence.ts`.

*Two deviations from the plan, both recorded rather than silent.* **(1) One tab, named "Trace",
holds both surfaces** (filmstrip above waterfall) rather than a tab called "Waterfall": one fetch
feeds both, and splitting them would have meant two panes reading the same payload. **(2) The plan
says this data can be checked against "the same run opened in the stored Lighthouse HTML report",
which turns out to be truer than intended — `network-requests` and `screenshot-thumbnails` are both
in Lighthouse's `hidden` audit group, so its own report never renders either one.** The comparison
was therefore made against the LHR embedded in that HTML file, and the wider point stands on the
record: this phase surfaces data every audit has always captured and no Lighthouse report has ever
shown.

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
