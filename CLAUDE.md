# CLAUDE.md

Guidance for Claude Code — and every sub-agent and parallel teammate — working in this repo.

## Project

Local Lighthouse auditing tool: a single-user, locally-run web app that audits Lighthouse
scores for one or many URLs (median-of-N runs, bounded concurrency), persists each run, and
shows a live dashboard. Stack: Next.js (App Router, TS, Node runtime) + Tailwind + shadcn/ui;
engine = `lighthouse` v13 + `chrome-launcher`; `p-queue`; `better-sqlite3` + Drizzle; SSE.

- Full spec: `PRD.md`. Build approach: frontend-first (build the full UI on mock data behind
  a typed client/contract seam, then wire the real engine).
- Status: greenfield — no app code yet.

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

Rules of thumb:

- **frontend-design drives all UI visuals** — invoke it before/while creating UI and follow
  it for this project's "precision instrument" aesthetic (dark, technical, gauge-like score
  rings, monospace data accents; never Inter / generic shadcn defaults).
- When several apply, **combine them**: build UI with `frontend-design` +
  `vercel-react-best-practices` + `shadcn`, then review with `web-design-guidelines`.
- If you orchestrate a team, restate the relevant skill in each teammate's spawn prompt too
  (belt-and-suspenders), since built-in Explore/Plan agents don't read this file.
