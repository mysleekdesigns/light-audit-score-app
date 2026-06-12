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

- Scoped rules live in `.claude/rules/` (security always-on; engine-workers, analysis-contract,
  db load when matching files are read). Follow them — they encode invariants like "Lighthouse
  only runs in the forked worker" and "AnalysisStreamEvent is frozen".
- Deterministic hooks (`.claude/settings.json` + `.claude/hooks/`) block secret-looking content
  in writes/commands, staging of `.env*`/`.mcp.json`, force-pushes to main/develop, and run
  `eslint --fix` after every TS edit. If a hook blocks you, fix the cause — never bypass it.
