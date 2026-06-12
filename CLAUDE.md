# CLAUDE.md

Guidance for Claude Code — and every sub-agent and parallel teammate — working in this repo.

## Project

Local Lighthouse auditing tool: a single-user, locally-run web app that audits Lighthouse
scores for one or many URLs (median-of-N runs, bounded concurrency), persists each run, and
shows a live dashboard. Stack: Next.js (App Router, TS, Node runtime) + Tailwind + shadcn/ui;
engine = `lighthouse` v13 + `chrome-launcher`; `p-queue`; `better-sqlite3` + Drizzle; SSE.

- Full spec: `PRD.md`. Launch plan: `SAAS_PLAN.md` — **LightAudit**, a local-first licensed
  desktop app (Electron) + thin license cloud, phases A–H.
- Status: core app built (engine, queue + forked workers, dashboard, history, PSI engine,
  AI score analysis). Current work: SAAS_PLAN.md phases A–H — drive them with `/next-phase`
  (it defaults to SAAS_PLAN.md; pass `@PRD.md` only to revisit the original build plan).

## Skills — invoke them (binding for ALL agents, including parallel teammates)

Skills are installed in `.claude/skills/`. Any agent doing work here MUST call the relevant
skill via the Skill tool when its trigger applies — do not hand-roll what a skill covers.
This applies equally to teammates spawned into a parallel team and to delegated sub-agents.

| Skill | Invoke when |
|---|---|
| **frontend-design** | Designing, building, or styling ANY UI (pages, components, layouts). Primary design authority. |
| **shadcn** | Adding/configuring/debugging shadcn/ui components or `components.json`. |
| **vercel-react-best-practices** | Writing, reviewing, or refactoring React/Next.js code (components, data fetching, performance). |
| **vercel-composition-patterns** | Designing component APIs / composition (compound components, context, reusable libraries) — e.g. the client/hook/contract seam. |
| **web-design-guidelines** | Reviewing built UI for accessibility / UX / web-interface-guideline compliance. |
| **electron-packaging** | Any SAAS_PLAN Phase A/E packaging work — Electron shell, electron-builder, ASAR, signing, auto-update. |
| **licensing** | Any SAAS_PLAN Phase B/C/E-Tier-3 work — entitlement tokens, Stripe, device binding, keychain. |
| **byo-ai-providers** | Any SAAS_PLAN Phase D work or changes under `src/lib/analysis/` — provider seam, drivers, degradation tiers. |

Rules of thumb:

- **frontend-design drives all UI visuals** — invoke it before/while creating UI and follow
  it for this project's "precision instrument" aesthetic (dark, technical, gauge-like score
  rings, monospace data accents; never Inter / generic shadcn defaults).
- When several apply, **combine them**: build UI with `frontend-design` +
  `vercel-react-best-practices` + `shadcn`, then review with `web-design-guidelines`.
- If you orchestrate a team, restate the relevant skill in each teammate's spawn prompt too
  (belt-and-suspenders), since built-in Explore/Plan agents don't read this file.

## Specialist sub-agents (`.claude/agents/`)

Prefer delegating matching work to these instead of generic agents — they carry the project's
invariants and preload the right skill:

- **electron-packager** — Phase A/E: Electron shell, packaging, signing, auto-update.
- **license-cloud-engineer** — Phase B/C: accounts, Stripe, entitlements, activation.
- **ai-provider-engineer** — Phase D: AnalysisProvider seam, Claude/Ollama/OpenAI-compatible drivers.
- **security-reviewer** (read-only) — run it after any change touching license checks, auth,
  billing, secrets, Electron config, deep links, or the local HTTP server.

## Rules & hooks

- Scoped rules live in `.claude/rules/` and are auto-loaded by file match: **security** is
  always on; **engine-workers**, **analysis-contract**, and **db** load when their matching
  files are read. They encode invariants like "Lighthouse only runs in the forked worker",
  "`AnalysisStreamEvent` is frozen", and "all DB paths go through `src/lib/db/paths.ts`".
- Deterministic hooks (`.claude/settings.json` → `.claude/hooks/`) enforce safety at tool-time.
  If a hook blocks you, **fix the cause — never bypass it**:

  | Hook | Fires on | Blocks / does |
  |---|---|---|
  | `guard-secrets.mjs` | `PreToolUse(Edit\|Write)` | Writing secret-looking content into any file |
  | `guard-bash.mjs` | `PreToolUse(Bash)` | Secret-looking content in commands; staging `.env*`/`.mcp.json`; force-pushes to `main`/`develop` |
  | `lint-fix.mjs` | `PostToolUse(Edit\|Write)` | Runs `eslint --fix` on touched TS, then blocks on any residual lint error |

  (`test-hooks.mjs` is a local test harness for the guards — it is **not** wired into
  `settings.json`, so it never runs as a hook.)

## How it fits together

A typical phase of work threads all of the above into one chain:

1. **`/next-phase` orchestrates.** It reads the plan (`SAAS_PLAN.md` by default), picks the next
   unchecked phase, and fans the independent slices out to sub-agents — keeping verification, the
   plan checkbox update, and the commit for itself (never delegated, so one consistent standard).
2. **Specialist agents do the slices.** Each `.claude/agents/` agent carries the project's
   invariants and **preloads its skill** (`electron-packager` → `electron-packaging`,
   `license-cloud-engineer` → `licensing`, `ai-provider-engineer` → `byo-ai-providers`). Restate
   the relevant skill in every spawn prompt — built-in Explore/Plan agents don't read this file.
3. **Skills supply the how.** Whoever does the work invokes the matching skill via the Skill tool
   and follows it — `frontend-design` + `vercel-react-best-practices` + `shadcn` for UI (review
   with `web-design-guidelines`), the phase skills for packaging/licensing/providers.
4. **Rules enforce invariants passively.** The moment a matching file is read, its rule loads and
   constrains the edit (worker isolation, frozen contracts, DB-path discipline, secrets in the
   keychain) — no one has to remember them.
5. **Hooks are the deterministic backstop.** They fire at tool-time regardless of intent (the
   table above): secret guards on writes/commands, `.env*`/`.mcp.json` + force-push blocks on
   Bash, and `eslint --fix` after every TS edit.
6. **`security-reviewer` gates the diff.** After any change touching license checks, auth,
   billing, secrets, Electron config, deep links, or the local HTTP server, run it (read-only)
   and resolve its Critical/High findings **before** the phase is considered done.

In short: **skills say how · agents carry context and preload skills · rules enforce invariants
on matching files · hooks block unsafe actions at tool-time · and `/next-phase` +
`security-reviewer` tie a phase together from kickoff to a verified, committed result.**
