# ROADMAP — Competitive differentiation plan (Phases A–H)

> **Status (updated 2026-09-06):** **Phases A–G complete. H is the only one left.**
>
> - **A** — the Agentic Browsing category is live end-to-end (engine → SQLite → UI → PSI → AI).
> - **B** — audits authenticate (basic auth, cookies, headers) for both auditing and crawl
>   discovery, with credentials redacted at every persistence boundary.
> - **C** — the daily scheduler finally notifies: an armed schedule compares each fire with the
>   one before it and reports what crossed, in-app and to an optional webhook.
> - **D** — every run opens a **Trace** tab: a request waterfall and a loading filmstrip, read
>   lazily from the report already on disk.
> - **E** — Compare answers *why* a score moved: a **What Changed** card diffs two runs audit by
>   audit, opportunity by opportunity and request by request, and can hand that delta to the AI so
>   it explains the regression rather than re-diagnosing the page.
> - **F** — the same engine runs as a build gate: `npm run ci` audits a URL list, a URL file or a
>   crawl, compares each page to a budget, exits 0/1/2, and archives every run to the same
>   History the app reads.
> - **G** — the app is an **MCP server**: four tools (`audit_url`, `get_history`, `compare_runs`,
>   `check_budget`) over a stdio pipe, so a coding agent audits the page it just changed and
>   compares it against the same local history the app shows. No port, no session token, no SDK —
>   the JSON-RPC layer is hand-written so nothing in the import graph can bind a socket.
>
> **Phase H is the only one unbuilt, and it has all three of its prerequisites (D, E and the
> reporters seam).**
> G's `security-reviewer` pass came back with no Critical and no High; both Mediums and five of
> six Lows were fixed before the phase closed — the notable one being that every ERROR path had
> its own weaker sanitiser than the payloads did, which is now one shared pipeline
> (`src/lib/text/displaySafe.ts`) used by the tools, the wire format, the URL normaliser and the
> CLI alike. E's pass was likewise clean, with its one Medium and all five Lows fixed (including a
> pre-existing one: a deleted run stayed readable from the queue's in-memory results). D's was
> clean across two independent reviewers.
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

Suite: lint · typecheck · build · **1199 tests**, all green (1039 → 1199).

*Security review (read-only `security-reviewer`, required by `.claude/rules/security.md` because
the phase adds a route to the local HTTP server): **pass — no Critical, no High.** Two reviewers
ran independently; every finding either reviewer raised was fixed here rather than deferred.*
(Both reports arrived only after a long delivery delay, during which the checks listed further
below were performed independently.)

**Where the two reviewers disagreed, the question was settled by experiment rather than argument.**
Reviewer 1 held that the route is reachable, with the session cookie attached, from a page served
on another loopback port — cookies ignore ports, and `SameSite=Strict` is scoped to the *site*, of
which a port is not part. Reviewer 2 held the opposite: that `sameSite: "strict"` means "a
cross-site page cannot reach this route at all". This is the difference between "a hostile local
page can make this server work" and "only the user can", so it was tested: a page served on
`127.0.0.1:3412` issuing a `no-cors`, `credentials: "include"` fetch at the app on
`127.0.0.1:3411` was answered **200**, cookie attached (observed at the network layer, since CORS
hides the reply from the page but not the request from the server). **Reviewer 1 is right**, and
the hardening below is aimed at a genuinely reachable surface. Reviewer 2's own severity call
rested on the opposite belief, so its M1 is treated as live, not discounted.

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

The second reviewer added three items of its own, all fixed:

- **Peak memory, not file size, is what needed bounding.** It corrected a belief I had stated: the
  sibling `GET /api/reports/:runId` does *not* stream either — it also reads the whole file — but it
  holds **one** copy and hands the string straight back, whereas this route holds the string, the
  parsed object graph (several times the text, for an LHR's many small objects), the projected
  arrays and the serialized response, all at once. So the ceiling was re-derived against that ~5–10×
  multiplier and lowered **32 MB → 8 MB**, still over 5× the largest report here.
- **The row label was unclamped where the hover title was clamped.** `clampText(url, 240)` guarded
  the `title`, but the visible label went into the DOM in full — and CSS `truncate` hides an
  over-long string without shortening it, so a megabyte-scale `data:` URL would put a megabyte in a
  text node, per row. Now clamped through the same `MAX_LABEL`, with tests.
- **`Cache-Control: no-store` is now explicit** on the trace response (both reviewers raised it). A
  trace embeds screenshots of the audited page, which Phase B made able to be a logged-in or
  staging one, so it should not be inherited from whatever a `force-dynamic` handler happens to
  emit.

**One fix outside Phase D's scope, flagged independently by both reviewers and taken anyway:** the
*sibling* `GET /api/reports/:runId` interpolated the caller's run id into its two 404 bodies, which
is the one place the project's no-reflection rule was not held. Two lines, no test depended on the
wording, and leaving a known reflection in place next to a route that documents the opposite would
have been the worse call.

Both reviewers confirmed, against the installed Lighthouse rather than by assumption, that the
filmstrip is capped at 8 frames and `data:` URLs are elided to ~100 chars — so the 234 KB payload
is not attacker-inflatable — and that the new modules apply no regex to report data, so there is no
ReDoS surface. Reviewer 2 additionally noted `splitUrl` and `isThirdParty` each construct a `URL`
per row: a constant factor, not a complexity problem, and left as is.

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

- [x] **Diff core**: a pure, unit-tested differ over two stored reports producing per-audit
      deltas (score, numeric value, wasted bytes/ms), classified as regressed / improved /
      unchanged / newly-present / disappeared.
      *Done: `src/lib/reports/diff-audits.ts`, pure in the `parseLhr` sense. It is TOTAL over
      the union of audit ids — it classifies the ~170 per run that did nothing as well — and
      the composer filters, because a differ that pre-filtered could not be unit-tested for
      "correctly reports unchanged", which is the property that makes the moved ones
      believable. Classification order is the contract: presence, then SCORE (which is what
      actually moved the category number), then a numeric fallback only when NEITHER side is
      scored. A scored-vs-unscored pair is `unchanged`/`basis: "none"`, never a direction —
      an audit that went from unscored to 0.5 has not improved by 0.5, which is Phase C's
      "a missing value is silence, not zero" applied here. The lower-is-better assumption
      behind the numeric fallback was VERIFIED rather than asserted: Lighthouse 13.4.1 pins
      `numericUnit` to `byte | millisecond | element | unitless` (`types/audit.d.ts:117`) and
      every emitter is a cost; a test scans all 225 stored reports and fails if a fifth unit
      ever appears, rather than letting the fallback silently invert. Two things the real
      reports taught us: the category join must union BOTH sides (the real pair the test picks
      differs by the entire `agentic-browsing` category, so a one-sided join would leave five
      real audits with no category), and `weight` must be the MAX across categories
      (`image-alt` is accessibility 10 / seo 1) or first-seen-wins mis-tiers the ranking.*
- [x] **Opportunity deltas**: rank by estimated savings change so the biggest regressions
      surface first; reuse the existing `Opportunity` shape.
      *Done: `OpportunityDelta` mirrors `Opportunity`'s field names side-for-side, and
      `savingsDeltaMs` is positive when the comparison run wastes MORE, so the default order
      is biggest-regression-first. Classified on SAVINGS rather than score, because an
      opportunity's whole point is the milliseconds it costs and many are scored `null` in a
      passing run. The load-bearing detail is that both sides are read UNCAPPED before the
      join: `parseOpportunities` caps at 15 per side, and a cap applied before the join
      silently drops an opportunity that exists on only one side — precisely the thing this
      feature is for. The corpus could not demonstrate that (real reports carry exactly 6),
      so the test for it is deliberately synthetic.*
- [x] **Resource deltas**: added / removed / grown requests, built on the Phase-D
      `network-requests` reader.
      *Done: `src/lib/reports/diff-requests.ts` over `extractWaterfall`, not beside it — that
      reader already knows the `-1` unknown sentinel, the `lhr.entities` third-party join and
      the v13 render-blocking rename, and re-deriving any of it would drift. Keyed by full URL
      and COUNTED, since 20 of this repo's 224 reports fetch some URL more than once (one
      fetches a font three times), so "the page now fetches this twice" stays visible.
      `unavailable` propagates: a diff where one side predates the audit is not a diff in
      which every request vanished. Reconciled against two real reports of the same page —
      23 → 22 requests, 11,800 → 11,296 bytes, each equal to that side's own Trace-tab total.
      **The finding worth recording:** diffing two runs of the same page is dominated by
      BEACON CHURN — 19 of 32 URL keys came out added/removed, nearly all analytics beacons
      whose query strings carry per-run session ids. That is correct under the contract but
      would read as "nine new resources", so both the UI and the AI prompt were built to say
      so rather than the keying being changed.*
- [x] **UI**: a third card on `/compare` beside Trend and Diff, and a "what changed" entry
      point from a Re-run's lineage chip (`↻ re-run of <prior>`), which is the natural place
      a user asks the question.
      *Done: a full-width "What Changed" card reusing the console's EXISTING run pickers (no
      second pair), with Audits / Opportunities / Requests / Explain tabs over a pure,
      unit-tested `what-changed-view.ts` — the same component/pure-module split Phase D used,
      because Vitest runs `environment: "node"` here with no jsdom. Both churn findings are
      designed for: the Requests tab leads with the churn-immune totals before any row and
      sorts size-CHANGED rows first (the only third of the table churn cannot manufacture),
      and the Audits tab leads with a `regressed · improved · presence only` tally with
      appeared/disappeared worded as presence, not verdict. Five distinguished empty states,
      `urlMismatch` surfaced as its own notice rather than as a regression, and no links on
      any page-authored URL — Phase D's standing decision. No new colour, font or token.
      The lineage chip resolves a prior BATCH to the matching prior RUN by `(url, formFactor)`
      through the house `pairByDevice` helper, ranked by points lost so a multi-page batch
      lands on the page that regressed hardest; devices are never crossed, and when no
      comparable pair exists the link is not rendered and the tooltip says why.*
- [x] **Feed the AI**: pass the audit-level delta into the analysis prompt so the AI explains
      *the regression* rather than re-diagnosing the page from scratch — the single highest-
      value use of the existing analysis layer.
      *Done as an additive seam: `runAnalysis({ diff })` → `buildAnalysisInput({ diff })` →
      a "What changed since the baseline run" section, with the closing instruction REPLACED
      by one of five branches (score down / up / flat-but-moved / not comparable / nothing
      moved in this category) so the model never invents a regression that did not happen.
      Both prompt tiers are covered. The no-diff prompt is pinned VERBATIM in the tests,
      because feeding a diff is additive and a byte of drift there is a regression in every
      existing analysis. Bounded hard (10 audits / 5 opportunities / 5 requests per bucket)
      and filtered to the analysed category, so an SEO analysis is not handed performance
      deltas. Page-authored strings go through `sanitizeUntrusted` and the `«…»` guards like
      every other untrusted value in that prompt. **Deviation, recorded:** a baseline-grounded
      analysis is neither replayed from the analysis cache nor persisted. The saved key is
      `(runId, category)`, so regression-flavoured text stored there would later replay as the
      plain "explain my SEO score" answer; widening the key would mean a unique index over a
      nullable column, where SQLite treats every NULL as distinct and the existing upsert would
      start writing duplicate rows.*
- [x] **Verify**: two runs of a deliberately-changed local page produce a diff that names the
      exact audit that moved, and an AI analysis of that diff cites the change.
      *Done against a purpose-built local fixture whose score moves deterministically — see
      the Gate note below.*

**Gate:** a real before/after pair on a locally-modified page yields a correct audit-level
diff (verified by hand against both stored HTML reports), and the AI analysis of the diff
identifies the introduced regression.

*Gate green (2026-09-06).* Verified against a purpose-built local fixture whose score moves
deterministically — the lever is SEO (`<title>` + meta description present or absent), because
Performance varies run to run and a Gate must not depend on noise, the same choice Phase C's
gate made. A second lever adds a real 42 KB subresource so the RESOURCE half has something true
to report.

- **Two runs through the real stack** (HTTP API → queue → forked worker → Chrome → SQLite),
  either side of the change: `seo 100 → 91`, with `performance 100 → 100` throughout, so every
  signal below is the change and not variance.
- **The diff matches an INDEPENDENT recomputation exactly, item for item.** The plan says to
  verify "against both stored HTML reports"; as Phase D found, Lighthouse's own report never
  renders `network-requests`, so the comparison is against the LHR that Lighthouse itself
  embedded in each stored HTML file, read by a script sharing no code with `src/lib/reports/`.
  Audits that moved: `meta-description` (1 → 0), `first-contentful-paint`, `unminified-javascript`
  — the same three, same directions, in both. Opportunity `unminified-javascript` +450 ms in both.
  Requests 4 → 5 and 6,345 → 48,427 bytes in both; `tracker.js` added at 42,246 bytes in both;
  two rows changed by −82 bytes in both. **That −82 is the removed `<meta name="description">`
  making the HTML smaller** — the diff is measuring the real thing, not a label.
- **157 unchanged audits were counted, never listed**, which is the differ/composer split working.
- **The AI analysis identified the introduced regression**, grounded in the diff rather than
  re-diagnosing the page: *"One audit accounts for the entire −9. `meta-description` went from
  100 → 0. Nothing else in the SEO category moved."* It cited sources it actually fetched.
- **The projection is 121× smaller than its inputs** — 4,151 bytes on the wire against 500,459
  bytes of stored reports — with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`
  on every path, and repeat reads served from the memo in ~2.4 ms.
- **No reflection, no traversal:** every error body is static, and `../../../../etc/passwd` as
  the route parameter returns a clean 404 (the id resolves through SQLite, so caller input never
  reaches `path.join`).
- **UI driven in real Chrome**: the lazy read is proven rather than asserted — **0** requests to
  `/diff` before the card is opened and **exactly 1** after; all four tabs render the right
  content (`meta-description` and `unminified-javascript` under Audits, `tracker.js` under
  Requests); the lineage chip on `/batches` produced a `/compare?…&changed=1` link that resolved
  a prior BATCH to the matching prior RUN and landed with the card open. **Zero console errors,
  zero page errors, zero failed requests** — the `?_rsc=` prefetch aborts are pre-existing Next.js
  router behaviour, confirmed by a control load of the untouched `/history` page producing 11 of
  its own. No horizontal overflow at any tab.

Suite: lint · typecheck · build · **1450 tests**, all green (1199 → 1450).

*Security review (read-only `security-reviewer`, required by `.claude/rules/security.md` because
the phase adds a route to the local HTTP server): **pass — no Critical, no High.** The one Medium
and all five Lows were fixed rather than deferred.*

- **M1 — a deleted run stayed readable from memory, and it was not this phase's bug but this
  phase's job to fix.** The queue retains every finished run's LHR so the report routes can serve
  a run that is not persisted yet, and NOTHING ever pruned that map: `deleteRun` and `clearHistory`
  removed the rows, the analyses, the alerts and the report files, but a deleted run kept answering
  `/trace` and `/diff` for the life of the process — its audited URL, every subresource URL, its
  filmstrip screenshots. Someone clearing history to remove the record of what they audited did not
  get that. Identical in shape to Phase C's M2. It predates Phase E (the committed trace route has
  the same check), but Phase E centralised that check into `loadReport.ts` and added a second, wider
  consumer, which is what made this the moment to fix it in one place. `forgetJobResults` on the
  queue is now called from both delete paths — via a LAZY import, since `AuditQueue` imports
  persistence and a static one would be a cycle. **Verified live, not just unit-tested**: with the
  report file deleted from disk, `/trace` still answered 200 (proving the queue genuinely is the
  answering path), and after deleting the run it returned 404.
- **L5 — the one finding that was mine, introduced during this phase.** I had widened the
  analyze route's in-flight key to `runId:category:baselineRunId` so a regression analysis could be
  its own artefact. It is one — but that map is the ONLY concurrency bound on an expensive provider
  process, and widening it removed the bound: switching the baseline picker and re-clicking would
  claim a fresh slot each time, so N baselines in history meant N concurrent agents under the
  5-minute timeout. Reverted to `runId:category`; a test now parks one analysis in flight and proves
  the second is refused while a different run still proceeds.
- **L4 — row COUNT was bounded, the strings inside a row were not.** An audited page can issue forty
  requests to a 400 KB URL; those survive the per-report ceiling and would make one response bounded
  only by the reports themselves, with the route's 16-entry memo retaining several. `url`/`path`/
  `host` are now clamped to `MAX_DIFF_URL` (2048), with a test proving the clamp cannot unmatch the
  aggregation key — the maps are built from the raw rows before it runs.
- **L3 — two doors into one lookup disagreed:** the analyze route bounded a run id at 64 characters
  and this route did not. Same bound now, applied before the DB probe and before either id can reach
  a cache key.
- **L1 and L2 were both docblocks that OVERCLAIMED**, and both were fixed in the prose rather than
  the code, because "fixing" either would have broken something real. `diff-requests.ts` said every
  `url`/`path`/`host` arrives `displaySafe`-d; `path` and `host` do, but `url` is deliberately raw
  because it is the join key for the entity table and the render-blocking match, and normalising one
  side of a join silently unmatches entries. `LoadReportResult.runId` promised "never the caller's
  string", which is true of the disk branch but not the queue fallback, where there is no row to
  round-trip through — that branch is safe because the value reached it by matching an existing
  nanoid job key exactly, which is a different reason and now says so. An overclaimed guarantee is
  worse than none: it is the note a later author cites to skip a check.

Its four hardening suggestions were taken too, in a follow-up commit. Two are worth naming:
the diff route and its hook keyed their caches on a **literal NUL byte in the source**, which is
correct but is exactly what a formatter or a copy-paste silently eats — and losing it would
re-admit the `("ab","c")` / `("a","bc")` collision with nothing visible in the diff, so both are
now written as a `\u0000` escape, the rule this repo already applies to the control/bidi class in
`displaySafe`. And `apiError` now sets `Cache-Control: no-store` on every error envelope
app-wide: a bare 4xx is heuristically cacheable under RFC 9111, and a cached
`404 report_not_found` for a run id that exists a moment later — a run still finishing, a report
still being written — is a correctness bug rather than merely a security nicety. Also: the
Requests table's `resourceType` is now clamped like every other string beside it, and the two
prompt fields that sit OUTSIDE the `«…»` guards (`fetchTime`, the Lighthouse versions) carry a
comment saying why — they are Lighthouse's own fields in our own artefact, and guarding them
would tell the model to distrust the one part of that section it can rely on.

**One suggestion was declined, deliberately:** a global ceiling on concurrent analyses
(`inFlight.size >= 4`). L5 was that Phase E had REMOVED the per-`(runId, category)` bound, and
that bound is restored; a global cap is a different, pre-existing question, it would refuse the
legitimate act of analysing several different runs at once, and the number would be arbitrary.
Recorded here rather than silently skipped.

The reviewer confirmed the diff leaves untouched `src/proxy.ts`, `src/lib/http/localGate.ts`,
`reportCsp.ts`, `scripts/start.mjs`, `scripts/session-token.mjs` and the Phase B credential paths
(`persistence.ts` was modified deliberately, for M1), and that the memo cannot serve a cached diff
for a deleted run — existence is re-checked on both ids before any hit is honoured.

*Three deviations from the plan, recorded rather than silent.* **(1) A baseline-grounded analysis is
neither cached nor persisted** — see the "Feed the AI" note above. **(2) The read path was extracted
rather than duplicated:** `src/lib/reports/loadReport.ts` now owns the degradation ladder, the
DB-resolved path and the peak-memory ceiling for BOTH report routes, and Phase D's `/trace` was
refactored onto it. Two routes re-deriving a reviewed security posture from memory is how two routes
end up with two postures — and M1 is the evidence, since it was exactly such a duplicated check.
**(3) The diff is one route, `GET /api/reports/:runId/diff?baseline=<id>`**, where the path segment
names the COMPARISON — the run the answer is about — matching its siblings and making "what changed
in this run?" a single URL.

---

### Phase F — `lightaudit-ci`: budgets with an exit code
**Why:** Unlighthouse's entire CI pitch is one line — `unlighthouse-ci --site … --budget 80`,
exit 1 on failure — and Lighthouse CI's is assertions. LightAudit Score has per-category pass
thresholds in the batch summary but **no non-zero exit anywhere**, and `npm run audit` is one
URL with no assertions. This is cheap, and it is the difference between "a tool I open" and
"a tool in my pipeline".

- [x] **Multi-URL CLI**: extend `scripts/audit-cli.ts` to accept a URL list, a file of URLs,
      or a crawl spec, reusing the *existing* `AuditQueue.createBatch` path — a new caller,
      not a new queue (the Phase-14 precedent).
      *Done: positional URLs, `--urls-file` (blank lines and `#` comments skipped, deduped) and
      `--crawl <seed>` (bounded by `--max-pages`/`--max-depth`/`--no-sitemap`/`--exclude-paths`,
      calling the existing `discover()` — no second crawler). All three compose into one
      order-preserving list. The load-bearing change is that execution now goes through
      `AuditQueue.createBatch` rather than calling `runAudit` per URL, which is what makes a CLI
      run a first-class run: it forks the same worker, persists the same rows, and shows up in
      the same archive. The existing developer output survives unchanged, because
      `getJobResult` still returns the full `AuditResult` with per-run spread and Best
      Practices.*
- [x] **Budgets**: `--budget <n>` (one threshold for every category) and per-category budgets
      from a config file, reusing the threshold shape Settings already persists. Exit 1 if
      any page fails any budget, exit 0 otherwise — that is the entire contract.
      *Done: `src/lib/ci/budgets.ts`, pure. `CiBudgets` is byte-identical to the shape the batch
      summary and Phase C's schedule alerts already use, so a bar means the same thing in a
      pipeline as on screen, and the boundary matches `rowClearsThresholds` (a score equal to
      the bar passes).
      **Precedence was the real decision, and it is inverted from the usual convention:** the
      flag is the FLOOR and the config is the exception list, so `--budget 90` plus
      `{"performance": 70}` reads as "90 everywhere, except performance only needs 70". The
      conventional "CLI flag beats config file" would make the pair useless — the blanket flag
      would flatten every per-category line the user wrote.
      A typo'd category is a hard error naming the valid ones rather than a silent ignore: a
      `"perfomance": 90` that quietly judged nothing would make a build pass for a reason nobody
      could see. Every message is self-contained (it lands in a CI log) and echoed input is
      truncated so a garbage flag cannot dump 500 characters into it.*
- [x] **Reporters**: `--reporter json|jsonExpanded|csv` to stdout or a path, plus a static
      HTML summary, matching what CI users already expect from the incumbents.
      *Done: `src/lib/ci/reporters.ts`, pure — it returns a string and the CLI decides stdout vs
      `--output`, which is what makes it testable. `json` and `jsonExpanded` differ only by the
      per-page `metrics` key, which is OMITTED rather than nulled in the compact form, so a
      consumer can tell "not in this format" from "this run had no metrics" (a failed run
      legitimately has `null`) and one parser reads either. The HTML is a genuinely standalone
      artifact: one inline `<style>`, no script/image/font/link, a `default-src 'none'` CSP meta,
      and every interpolated value through strip → clamp → escape, since there is no React here
      doing it. Verified in a real browser opening it from `file://`: zero resource entries.
      No links on any page-authored URL — Phase C's L1 and Phase D's no-links decision.*
- [x] **Headless-safe**: no session token, no browser open, no server required — the CLI
      talks to the engine and SQLite directly. Runs must still persist to History so CI runs
      and UI runs share one archive (that shared archive is the differentiator).
      *Done, and the shared archive is verified rather than asserted — see the Gate note. The
      CLI imports neither `src/proxy.ts` nor `src/lib/http/localGate.ts` and needs no
      `LH_SESSION_TOKEN`; Chrome still launches headless, because that is what an audit is, and
      the README says so rather than letting "no browser" read as "no Chrome". The process exits
      on its own: nothing in the import graph starts a timer (the scheduler is started only by
      Next's `instrumentation.ts`), and settlement resolves on `batch-completed` OR
      `batch-cancelled`, with a terminal-snapshot re-check for a batch finalised inline. No
      wall-clock timeout was added, deliberately: a legitimate `--runs=5` audit of many pages
      runs for minutes, and a timer that killed it would turn a slow build into a false
      regression — the exact confusion `EXIT_USAGE` exists to prevent.*
- [x] **Docs**: a README section with a GitHub Actions example, since that is how this feature
      gets discovered.
      *Done: `## CI: budgets with an exit code` — targets/budgets/reporters tables, the exit-code
      table, a config example, and a copy-pasteable workflow that checks the repo out, runs the
      gate and uploads the HTML report `if: always()`. It names the two traps a reader hits
      first: `npm ci` and `npm run ci` are unrelated commands that share three letters, and
      `data/` lives in the checkout a runner throws away, so `LH_DATA_DIR` is what makes the
      archive accumulate across builds.*
- [x] **Verify**: a passing budget exits 0, a failing budget exits 1 and names the failing
      page + category, and both runs appear in the app's History afterwards.
      *Done — see the Gate note below, including the race it caught.*

**Gate:** a real two-URL CI invocation with a deliberately unreachable budget exits 1 with a
useful message; the same invocation with a reachable budget exits 0; both persist to History
and open in the UI.

*Gate green (2026-09-06).* Two URLs on a local fixture (`/` and `/other`), one run each,
`--categories=performance,accessibility,seo`, through the real stack (CLI → `AuditQueue` →
forked worker → Chrome → SQLite).

- **Unreachable budget (100) → exit 1**, naming the page and the category:
  `accessibility 85 < 100` for both pages; report `{"ok":false, passed:0, failed:2}`.
- **Reachable budget (80) → exit 0**: `✓ 2 of 2 page(s) met every budget`, report
  `{"ok":true, passed:2, failed:0}`.
- **A usage error is distinguishable from a regression**: a missing config file exits **2**, not
  1, so a typo in a pipeline does not read as a performance regression.
- **Both runs persisted and open in the UI.** Two rows in the real `data/lighthouse.db` with
  their report files, under a `completed` batch, rendering in `/history` under the fixture's
  site section alongside runs done by hand and by PSI. They are fully first-class: their stored
  reports serve over `GET /api/reports/:runId` (200), Phase D's `/trace` renders their waterfall
  and filmstrip (200), and Phase E's `/diff` runs across the two of them — correctly reporting
  `urlMismatch: true`, since `/` and `/other` are different pages. A CI run is not a second-class
  artefact; it is a run.
- **The forked worker was re-verified from the web UI** after the `alias-hooks.mjs` change, since
  that file is `--import`ed by the worker as well as the CLI: an audit submitted through the
  running app completed normally (`performance 100`).

Suite: lint · typecheck · build · **1576 tests**, all green (1450 → 1576).

**The Gate caught a real bug, and it was not in this phase's code.** The first passing run
reported `pages: 1` for a two-URL invocation — a gate silently judging half of what it audited,
which would pass a build nobody checked. Both runs *were* in SQLite, so the CLI was not at fault:

- `AuditQueue.runJob` set `job.status = "done"` BEFORE `await recordRun(...)`, while
  `maybeFinalizeBatch` decides a batch is over by reading `job.status` across the batch. With two
  jobs in flight, job B could mark itself done and enter its persist while job A's completion
  finalised the batch — emitting `batch-completed` with B's row unwritten. The code's own comment
  said "Persist the run BEFORE announcing the job as done"; the ordering defeated it.
- The web UI never noticed, because it re-fetches. **The CI runner is the first consumer that
  reads once and exits** — which is precisely why the contract's decision to compute the verdict
  from PERSISTED rows was worth making: it turned an invisible race into a visible wrong number.
- Fixed at the source (the status assignment moved after the persist, so "settled" means
  "persisted"), with a regression test **confirmed to fail against the old ordering** before it
  was trusted. The CLI additionally refuses to judge a partial batch rather than scoring whatever
  it finds, because that failure mode is silent and a loud one costs nothing.

A second contradiction was found the same way: an errored run with no budgets exited 1 while the
JSON reported `"ok": true, "passed": 1`. Anything reading the report saw green for a red build.
`ok` is now computed once, in `evaluateBudgets`, and `exitCodeFor` is exactly `report.ok` — the
CLI no longer carries a second rule that can disagree with the artefact it prints.

*Also fixed here, though it predates the phase:* `csvCell` had no defence against spreadsheet
FORMULA INJECTION. ROADMAP Phase A's review raised it and correctly left it as pre-existing; Phase
F is what makes it live, because `--reporter csv` writes a file a pipeline archives and a human
later opens in Excel, which is exactly the path the attack needs. A leading `=`, `+`, `-`, `@`,
tab or CR is now neutralised with a leading apostrophe — losslessly, so the value still
round-trips for a program parsing the CSV — including the tab/CR bypass that defeats a naive
prefix check.

*Security review (read-only `security-reviewer`, required by `.claude/rules/security.md` because
the phase makes claims about the session-token boundary and adds a CLI that reads and writes
files): **no Critical. Two High, two Medium and four Low — all eight fixed rather than deferred.***

- **H1 — the alias-hook change could have broken every audit, in a package nobody edited.**
  `module.registerHooks` intercepts CommonJS `require()` as well as ESM `import`, and
  `parentURL` is a `file:` URL for everything on disk — `node_modules` included. So the new
  relative branch also rewrote `require("./x")` inside dependencies, and a hit was not merely
  wrong but FATAL: the rewritten value is a `file://` href, which `Module._resolveFilename`
  cannot consume. Since this hook rides the forked worker's `execArgv`, that is every audit,
  including from the web UI. The reviewer proved it rather than argued it, and also established
  it was not live today: exactly one `.js`/`.ts` collision exists across 5,521 `node_modules`
  directories (`image-ssim`), and its only consumer imports it by bare specifier. Fixed by
  confining the branch to the project's own files (under the repo root, outside `node_modules`)
  — the only set that has the problem. Verified both directions: a synthetic dependency doing
  `require("./dep")` beside a `dep.ts` now resolves `dep.js` correctly, and the worker still
  resolves its whole graph.
- **H2 — the CLI accepted `https://user:pass@host` and would have published it.** `POST
  /api/audits` refuses userinfo precisely because the URL is written verbatim into `runs.url`,
  and Phase B's whole point is that a credential never reaches SQLite. The CLI was a second door
  to the same archive with the check missing — and the worse door, because the README's own
  Actions example uploads the report as a build artifact. Now refused as a usage error, before
  Chrome starts, with a pointer to `LH_AUDIT_BASIC_AUTH`. Verified live: exit 2, and the secret
  appears zero times in the output.
  **The fix is deliberately validate-then-discard:** the parsed `URL` is used only to check the
  scheme and userinfo, and the string as TYPED is what gets audited and stored. Returning
  `url.toString()` would canonicalise `https://example.com` to `https://example.com/`, and since
  `runs.url` is the key History groups by and Compare trends on, that would file a CLI run and a
  UI run of the same page under two different URLs — quietly splitting the shared archive this
  phase exists to build.
- **M1 — a failed report write printed a stack trace and exited 1**, which a pipeline reads as
  "the site regressed", after paying for the whole audit. Now a `EXIT_USAGE` with a one-line
  message, the verdict still printed first, and a top-level `catch` so nothing escapes as an
  unhandled rejection. Verified live: exit 2, zero stack-trace lines.
- **M2 — target URLs were echoed to stderr raw** while every other untrusted string on that path
  went through `sanitizeMessage`. A `--urls-file` line can carry a lone CR (the parser splits on
  `\r?\n`), which lets input rewrite the log line around it — Phase C's L1 in a new place. Fixed
  at the point of ECHO with a `displayUrl` helper, rather than by mangling the address that gets
  stored.
- **L1 was a claim I wrote and got wrong.** `csvCell`'s docblock said the formula-injection fix
  was lossless; it is not. The apostrophe sits inside the quotes, so an RFC 4180 parser reads
  `=SUM(A1)` back as `'=SUM(A1)`, and a future negative-numeric column would export as text. No
  column today is affected. The docblock now states the cost, and the test asserts the exact cell
  rather than implying the claim.
- Also fixed: `--config` parse failures echoed ten bytes of the file (so `--config .env` leaked
  into a CI log) — now a static message; `--output` wrote world-readable, now `0600`, since a
  report embeds every audited URL and Phase B made those able to be staging pages; and the flag
  map is null-prototype so a `--constructor` flag cannot read back an inherited member.

*Re-review (same reviewer, against the fixed tree): **pass — no Critical, High or Medium.** It
confirmed the `runJob` reorder is correct and that no event consumer sees an ordering change (the
`job-completed` emit was already after the persist, so only pollers see `running` for longer), and
noted that two existing consumers — the scheduler and the lineage helper — read `done` to mean "has
a persisted row", which the old ordering made only *nearly* true. Its five new Lows were all fixed:*

- **A window my own reorder opened.** `cancelBatch` flips `running` jobs to `cancelled`, and a job
  now sits in `running` for the whole persist — so a Ctrl-C landing there was overwritten back to
  `done`, emitting `job-completed` AFTER `batch-cancelled`. A post-terminal event is something a UI
  can act on, so the cancel now wins; the persisted row is kept either way, matching `cancelBatch`'s
  own rule that a finished job keeps its run.
- **The HTML artifact contradicted itself.** With no budgets and an errored page it rendered
  "1 of 1 page missed a budget · 0 violations" — sending a reader after a budget that was never
  configured. It now says "could not be audited". The stderr path already had that branch; the HTML
  did not.
- **A forging vector that had moved rather than closed.** `displayUrl` cleaned the success path, but
  refusing a target still echoes it, and the rejection path was raw. Both now share one strip.
  Probing that fix turned up something better than the reported bug: WHATWG `URL` **strips** tab/CR/LF
  while parsing, so `https://x.test/<CR>y` validated cleanly and the raw CR travelled on into
  `runs.url`. Control characters in a target are now refused outright — which keeps the stored URL
  identical to what the web path stores (canonicalising would have split the archive) and loses
  nothing real.
- Two stale docblocks my `ok` change had invalidated (`totals` in `types.ts`, the module header in
  `budgets.ts`), plus a `keep this true` note on the `recordRun`-never-throws invariant the catch
  block now depends on.

The reviewer separately confirmed by walking the CLI's 32-module import graph that `src/proxy.ts`,
`src/lib/http/localGate.ts` and all of `src/lib/http/` are unreachable and no `LH_SESSION_TOKEN`
read appears anywhere in it — so "no session token, no server" is verified, not asserted — and
that the HTML reporter survived every payload it was given (no `<script`, no `href=`, no attribute
breakout; the only data-built attribute is a width percentage that cannot be anything but a
number).

*Three deviations from the plan, recorded.* **(1) A third exit code.** The plan says "exit 1 if any
page fails any budget, exit 0 otherwise — that is the entire contract". `EXIT_USAGE = 2` was added
for "the run could not be attempted at all" (bad flags, unreadable config, no targets). It
preserves the contract — non-zero still fails a build — while stopping a config typo from reading
as a site regression. **(2) `scripts/alias-hooks.mjs` was extended** to resolve extensionless
RELATIVE specifiers, not just `@/` ones, because `src/lib/crawl/*` imports its siblings that way
and `--crawl` cannot reach `discover()` otherwise. That file is also `--import`ed by the forked
audit worker, so this changes module resolution for every Lighthouse run; the branch is guarded to
extensionless relative specifiers from `file:` importers **inside the project's own tree** that
resolve to a real `.ts` — that last clause is H1's fix, and without it the change would have been
the phase's worst bug rather than an enabler. Phase G's `scripts/mcp-server.ts` will hit the same
wall. **(3) `npm run audit` now persists.** Routing the CLI through `AuditQueue.createBatch` means
the existing developer command archives its runs too, where before it printed and forgot. That is
the shared archive the checklist asks for, and it is a behaviour change to a command that predates
this phase.

---

### Phase G — LightAudit Score as an MCP server
**Why:** the widest part of the moat. Lighthouse MCP servers exist (danielsogl's, and Chrome
DevTools MCP now wraps Lighthouse), but they are **stateless single-page wrappers**. You have
an **audit history database**. Exposing LightAudit Score over MCP lets Claude Code or any agent
audit a page *during development* and compare it against months of your own baselines —
"did my change regress the page?" answered from real local history. Given the app is already
AI-native, this is the most defensible item on the list.

- [x] **Server**: a stdio MCP server entry point (`scripts/mcp-server.ts`) run under the same
      native-TS invocation as the other scripts (never `tsx` — see README Requirements).
      *Done, and `npm run mcp` is the same launcher line the other scripts use. The protocol
      layer is HAND-WRITTEN (`src/lib/mcp/protocol.ts`), which was the phase's one real
      build-or-buy decision: `@modelcontextprotocol/sdk` pulls `express`, `hono`, `cors`, `jose`
      and `eventsource` — an HTTP server and an OAuth stack — to expose four local tools over a
      pipe, and this phase's security clause is "must not open a port". The strongest way to keep
      that promise is for nothing in the import graph to be ABLE to, which also makes it
      auditable by reading one directory instead of a lockfile. Line-delimited JSON-RPC is small
      enough to own; the same argument the repo already made for `src/lib/http/localGate.ts`.
      Two invariants the entry point exists to hold: stdout carries frames and nothing else (one
      stray `console.log` anywhere in the 44-file import graph drops the connection), and the
      process `chdir`s to the project root at startup — an MCP client launches its servers from
      ITS cwd, and without that an agent's audits would accumulate in a second, invisible
      database, destroying the one thing this phase is for.*
- [x] **Tools**: `audit_url` (run and return scores), `get_history` (recent runs for a URL),
      `compare_runs` (Phase-E diff between two run ids), `check_budget` (Phase-F assertion,
      structured pass/fail). Keep the tool surface small and the payloads compact — an agent
      pays for every token of a Lighthouse report.
      *Done. Four tools, no more: every description sits in the model's context for the whole
      session whether it is called or not. `audit_url` returns scores and Core Web Vitals and
      never an LHR; `compare_runs` projects the `RunDiff` down and drops the request URL lists
      (unbounded, page-controlled, and mostly analytics churn) in favour of counts and byte
      deltas, keeping a `truncated` block so a model cannot mistake "3 audits moved" for "3 of 60".
      One deliberate divergence from the app: `audit_url` defaults to `runs: 1`, not 3 — an agent
      blocks synchronously inside the call with no progress to watch, so median-of-3 triples a
      wait it cannot see; the description says so and says to pass `runs: 3` before trusting a
      performance number.*
- [x] **Reuse, don't fork**: the tools call the same queue, persistence and diff modules as
      the app. No second engine, no duplicated scoring.
      *Done, and it cost two extractions rather than any new logic. `src/lib/ci/runBatch.ts` now
      holds the headless "create a batch, wait for it, read back the PERSISTED rows" seam that
      Phase F had written inside `scripts/audit-cli.ts`, so the CLI and `audit_url` share one
      settlement rule and one definition of what a verdict is computed from; the CLI keeps the
      verdict itself, because a build's exit code is its own. `src/lib/urls/normalizeAuditUrl.ts`
      holds the URL normaliser for the same reason, and that one is load-bearing: its return
      value is the key History groups by, so two callers with two normalisers would file the same
      page under two URLs and quietly split the archive this phase exists to compare against.
      `compare_runs` calls `extractRunDiff`, `check_budget` calls `resolveBudgets`/
      `evaluateBudgets` — including its inverted precedence — and no tool touches Drizzle directly.*
- [x] **Security**: the MCP server is a *local* process speaking stdio — it must not open a
      port, must not require or expose the session token, and must not read or forward any
      third-party credential. `security-reviewer` must review it before the Gate is green.
      *Done; **no Critical and no High**. All three clauses verified rather than asserted: the
      import graph references no `node:net`/`node:http`/`createServer`/`.listen(`, and
      `lsof -nP -a -p <pid> -i` against the live server returns nothing (an `audit_url` does fork
      a worker that gives Chrome a loopback DevTools port — the engine's behaviour on every audit
      path, and not this process). No `LH_SESSION_TOKEN`, `lh_session` or `localGate` anywhere in
      the graph; the gate lives in `src/proxy.ts`, which is not imported. No CrawlForge/Anthropic
      path is reachable and the documented `.mcp.json` snippet carries no `env` block.
      Both Mediums were fixed before the phase closed. **M1** was the interesting one: `safeText`
      guarded every payload, but each ERROR path had its own weaker strip that removed C0/C1 and
      left the bidi class — so a refused `ftp://…/<RTL>gnp.exe` reached the transcript reading as
      `…/exe.png`. The fix was to stop having six sanitisers: one pipeline now lives in
      `src/lib/text/displaySafe.ts`, imports nothing (so even the dependency-free wire format can
      use it), and is shared by the tools, the JSON-RPC error path, the URL normaliser and the
      CLI's terminal output. **M2** was retention and concurrency: the queue keeps every run's
      ~1 MB LHR and the app's deletion paths are what prune it, which is harmless for a request
      and a slow leak for a process that lives a whole coding session — `audit_url` now releases
      it once the report is on disk (and only then, so a failed write keeps its last reader) —
      plus a ceiling of four in-flight `tools/call`s, with `initialize`/`ping`/`tools/list`
      exempt so the server stays answerable under load. Five of six Lows fixed too: the echoed
      `runId` now goes through the sanitiser, `check_budget` reads one indexed row instead of the
      whole archive, `get_history`'s ceiling dropped 50 → 25 once its worst case was priced
      honestly, and the README stopped listing only what the server does NOT do (an agent you
      connect can read your entire audit history, and `.env` audit credentials still apply to an
      allow-listed host). The sixth is accepted and recorded rather than fixed: `finalUrl` gives
      an audited page ~300 characters in the model's context, which is the price of telling the
      agent a redirect happened at all.*
- [x] **Docs**: a copy-pasteable `.mcp.json` / `claude mcp add` snippet, and a short
      "audit-driven development" walkthrough.
      *Done: README `## MCP: audits from your coding agent` — both setup forms (with the warning
      that relative paths resolve against the AGENT's cwd, not the checkout's), a tool table with
      what each costs, the walkthrough written as the prompts a person actually types rather than
      as JSON-RPC, a Security section, and a Traps section. The trap that matters most is the one
      the code already defends: which directory the server runs from decides which archive it
      writes to, and an `LH_DATA_DIR` that disagrees with the app's gives you two histories.*
- [x] **Verify**: a real Claude Code session adds the server, audits a local dev URL, reads
      that URL's history, and reports a regression against a stored baseline.
      *Done — see the Gate note below.*

**Gate:** a live agent session drives all four tools end-to-end against a real local site;
`security-reviewer` reports no Critical/High; no port is opened and no token is required.

*Gate green (2026-09-06), re-run after the security fixes.* `claude mcp add lightaudit -- node …
scripts/mcp-server.ts` registers, and `claude mcp get lightaudit` reports **✔ Connected** against
Claude Code 2.1.x — the hand-written protocol talking to the real client, not a test double.

- **All four tools, driven by a live `claude -p` session** against a local fixture served on
  127.0.0.1: `audit_url` (11.9 s for one run, real headless Chrome) → `get_history` → the
  `compare_runs` of those two ids → `check_budget`. The fixture was edited between the two audits
  to regress it (a blocking script, an unsized image, low-contrast text), and the agent reported
  the regression from the diff rather than from the scores: performance 100 → 74, accessibility
  85 → 66, seo 91 → 83, with FCP/LCP/Speed Index the top movers and `unsized-images` newly
  failing — and it inferred the cause (one added, paint-blocking image) from the resource summary.
- **`check_budget` reproduced the CI contract's decision 2 without being told it:** with three
  categories audited and a blanket bar of 90, the two categories the run never scored came back
  as violations, not passes, and the agent explained why in those terms.
- **No port, no token.** `lsof -nP -a -p <server pid> -i` → nothing, checked while the server was
  live and idle. The server ran with no `LH_SESSION_TOKEN` in its environment.
- **The shared archive is real, not asserted.** The agent's runs went into the app's own
  `data/lighthouse.db` — the same 274-run archive — and `get_history` found the app's earlier runs
  alongside the agent's own.

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
