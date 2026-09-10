# CLAUDE.md

Guidance for Claude Code — and every sub-agent and parallel teammate — working in this repo.

## Project

Local Lighthouse auditing tool: a single-user, locally-run web app that audits Lighthouse
scores for one or many URLs (median-of-N runs, bounded concurrency), persists each run, and
shows a live dashboard. Stack: Next.js (App Router, TS, Node runtime) + Tailwind + shadcn/ui;
engine = `lighthouse` v13 + `chrome-launcher`; `p-queue`; `better-sqlite3` + Drizzle; SSE.

- Full spec: `PRD.md`. **LightAudit Score** is a **free, standalone** local audit app distributed
  **as source**: clone the repo, `npm install`, `npm start`.
- Status: core app built (engine, queue + forked workers, dashboard, history, PSI engine,
  AI score analysis, CrawlForge research server, gated local server). The launch plan
  (`SAAS_PLAN.md`, phases A–H) was **removed from the repo on 2026-09-02** — its history is in
  git. `/next-phase` therefore has no default plan any more: pass a plan file explicitly
  (e.g. `/next-phase @PRD.md`).

> **Model change (2026-09-02).**
> The app is free and **standalone**. Licence enforcement, anti-piracy hardening and cloud sync
> are retired. The `cloud/` billing app that backed the paid tier was **deleted on 2026-09-03**
> (last version is tagged `cloud-archive`); nothing hosted remains. Phase
> letters were renumbered, so a phase letter from an older conversation may not mean what it used
> to. Monetisation is deliberately unresolved (Phase G).
>
> **There is NO Electron.** The Electron shell, `electron-builder`, packaging, signing and
> auto-update were removed on 2026-09-02, along with the `electron-packaging` skill and the
> `electron-packager` agent. Distribution is a source checkout run with `npm start`
> (`scripts/start.mjs` builds on first run). Do not reintroduce Electron, packaging, or a
> compiled-worker build step.
>
> **Secrets live in `.env`.** `safeStorage`/OS-keychain storage went with Electron. Keys are read
> from `process.env` (normally a gitignored `.env`); Settings panels are read-only status plus
> guidance, never key-entry forms.
>
> **LightAudit Score ships no third-party application.** AI analysis can optionally use a **research MCP
> server**, but that server is separate software the user installs and authenticates themselves —
> never bundled, never installed by us, and its credentials are never stored or displayed by
> LightAudit Score. The generic seam stays vendor-neutral: any server declared in an MCP config works.
> **CrawlForge is the ONE named exception** (2026-09-02, at the owner's request — it is their own
> MCP server): an opt-in switch in Settings → Web research, off by default, that launches a
> pinned `npx -y crawlforge-mcp-server@<version>` on demand, lets CrawlForge read its own setup
> file (`~/.crawlforge/config.json` — LightAudit Score existence-checks it, never opens it, forwards no
> key), and strips its credit-heavy tools from the agent (`src/lib/analysis/providers/crawlforge.ts`).
> Do not add other product names, do not bundle or auto-install CrawlForge, do not turn it on by
> default, and do not forward a key to it (the Agent SDK puts MCP launch configs on the `claude`
> command line).

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
| **byo-ai-providers** | Any BYO-AI provider work or changes under `src/lib/analysis/` — provider seam, drivers, degradation tiers, research server. |

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

- **ai-provider-engineer** — AnalysisProvider seam, Claude/Ollama/OpenAI-compatible drivers.
- **security-reviewer** (read-only) — run it after any change touching auth, secret handling,
  the PSI or AI-provider key paths, the proxy (request gate)/session token, or the local HTTP server.

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
  `settings.json`, so it never runs as a hook. After editing any guard, run
  `node .claude/hooks/test-hooks.mjs`; all cases must pass. The hooks are wired in exec form
  — `"command": "node"` plus an `args` array — so the `${CLAUDE_PROJECT_DIR}` path needs no
  shell quoting.)

## How it fits together

A typical phase of work threads all of the above into one chain:

1. **`/next-phase` orchestrates.** It reads the plan file you pass it (there is no default since
   `SAAS_PLAN.md` was retired), picks the next unchecked phase, and fans the independent slices
   out to sub-agents — keeping verification, the plan checkbox update, and the commit for itself
   (never delegated, so one consistent standard).
2. **Specialist agents do the slices.** Each `.claude/agents/` agent carries the project's
   invariants and **preloads its skill** (`ai-provider-engineer` → `byo-ai-providers`). Restate
   the relevant skill in every spawn prompt — built-in Explore/Plan agents don't read this file.
3. **Skills supply the how.** Whoever does the work invokes the matching skill via the Skill tool
   and follows it — `frontend-design` + `vercel-react-best-practices` + `shadcn` for UI (review
   with `web-design-guidelines`), `byo-ai-providers` for the analysis layer.
4. **Rules enforce invariants passively.** The moment a matching file is read, its rule loads and
   constrains the edit (worker isolation, frozen contracts, DB-path discipline, secrets in the
   keychain) — no one has to remember them.
5. **Hooks are the deterministic backstop.** They fire at tool-time regardless of intent (the
   table above): secret guards on writes/commands, `.env*`/`.mcp.json` + force-push blocks on
   Bash, and `eslint --fix` after every TS edit.
6. **`security-reviewer` gates the diff.** After any change touching auth, secret handling, the
   proxy (request gate)/session token, or the local HTTP server, run it (read-only) and resolve its
   Critical/High findings **before** the phase is considered done.

In short: **skills say how · agents carry context and preload skills · rules enforce invariants
on matching files · hooks block unsafe actions at tool-time · and `/next-phase` +
`security-reviewer` tie a phase together from kickoff to a verified, committed result.**

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
