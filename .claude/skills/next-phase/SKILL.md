---
name: next-phase
description: Build the next unfinished phase of a plan file using a parallel team of sub-agents, run the full verification gate until everything is green, check off the plan's checklist, then commit and push. Use when asked to "work on the next phase", "build/do the next phase", "advance the plan", or via /next-phase. Requires a plan file argument (e.g. /next-phase @PRD.md, or /next-phase @ROADMAP.md 3) — there is no default plan.
argument-hint: "@plan-file [phase letter/number or range]"
metadata:
  version: "3.0.0"
---

# next-phase

Drive a phased plan to completion, one phase at a time, using a **parallel team of sub-agents**
for the independent work.

A phase is only "done" when its checklist is implemented, the **Gate is green**, the plan file
is updated, and the work is committed and pushed.

This skill is the orchestrator. You (the main agent running this skill) own selection,
decomposition, integration, verification, the plan update, and the git commit/push.
Sub-agents own implementation of disjoint slices. **Never delegate the verification gate or
the commit** — those are yours so the phase is judged by one consistent standard.

## The plan file is an argument, not a default

`SAAS_PLAN.md` was removed from this repo on 2026-09-02, so **there is no default plan**. The
invocation must name one, e.g. `/next-phase @PRD.md` or `/next-phase @ROADMAP.md D`.

- **If no plan file was named**, stop and ask which one to drive. List the candidate plan files
  actually present in the repo root (`ls *.md`) rather than guessing. Do not fall back to
  `SAAS_PLAN.md`, and do not reconstruct it from git history.
- Everything below that says "the plan" means the file the user named: its checklists, its
  **Gate**/**Verify** lines, its checkbox flips, its status note.
- `PRD.md` §6 is the original build plan (phases 0–9, complete). Only drive it when the user
  explicitly names a phase in it.

## Operating rules (read first)

- **One phase per invocation, in the plan's own dependency order.** Read the plan's sequencing
  from the plan itself — don't carry over phase letters from an older conversation, since they
  were renumbered when the paid tier was retired. Default to the *first phase in that order
  with unchecked `[ ]` items*. Only the *items within* a phase get parallelized.
- **External prerequisites are reported, not faked.** A plan may include things only the user
  can provide (a third-party account, a deployed service, a second OS). Implement and verify
  everything locally verifiable; list the gate clauses blocked on user-supplied
  credentials/infrastructure explicitly in your report — never check them off, never silently
  skip them.
- **Retired scope — refuse it if a plan still asks for it.** There is no Electron, packaging,
  signing, or auto-update step; no licence enforcement or anti-piracy work; no cloud/billing
  backend (`cloud/` was deleted 2026-09-03, tagged `cloud-archive`). If the plan file you were
  handed contains such a phase, say so and skip it rather than reintroducing any of it.
- **Skills are binding for every agent** (per `CLAUDE.md`). Restate the applicable skills in
  each spawn prompt (built-in Explore/Plan agents don't read `CLAUDE.md`):
  - UI work → `frontend-design` + `vercel-react-best-practices` + `shadcn`, review with `web-design-guidelines`.
  - Component APIs / contract seams → `vercel-composition-patterns`.
  - Anything under `src/lib/analysis/` → `byo-ai-providers`.
- **Prefer the specialist sub-agents** in `.claude/agents/` over generic ones:
  `ai-provider-engineer` for provider/analysis work. After any phase touching auth, secret
  handling, the proxy (request gate)/session token, or the local HTTP server, run the
  read-only `security-reviewer` agent over the diff before the gate is called green.
- **Don't fake completion.** If the gate fails, fix it or report the failure honestly —
  never check off a plan item or commit on red.

## Procedure

### 1. Preflight
- Confirm the plan file argument (see above). Read it in full before planning anything.
- Confirm a git repo and capture the branch: `git rev-parse --is-inside-work-tree`,
  `git branch --show-current` (this repo: branch `develop`, remote `origin`). If on the
  default branch (`main`/`master`), create a feature branch first.
- `git status --short` — if there are unrelated uncommitted changes, surface them and ask
  before mixing them into this phase's commit.
- Read `CLAUDE.md` (skills + conventions) alongside the plan. Re-read each time; don't trust a
  stale memory of the phases.
- Load the orchestration tools you'll need:
  `ToolSearch select:TeamCreate,SendMessage,TaskList,TaskGet,TaskOutput,TeamDelete`.

### 2. Select the phase
- If the user passed a phase letter/number or range, use it. Otherwise pick the **first phase
  in the plan's dependency order with any unchecked `[ ]` item**.
- Quote the phase's title, its checklist items, and its **Gate** line back to the user in one
  short line so the scope is explicit before you spend effort. Note any ⚠️ risk callout the
  plan attaches to the phase.

### 3. Decompose into parallel workstreams
- Split the phase's checklist into the **fewest** workstreams that are genuinely independent,
  and assign each a **disjoint set of files/dirs** (no two agents write the same file). Shared
  contracts/types are written **first by you** (or one agent) so parallel agents can code
  against a stable seam.
- Keep tightly-coupled or ordering-sensitive bootstrap steps for yourself, done directly and
  first (e.g. creating a shared schema, installing deps others import). Do the phase's flagged
  risk prototype before fanning out. Parallelize only what's safe — correctness beats fan-out.
- Sketch the ownership map (agent → files → checklist items it satisfies) before spawning.

### 4. Spawn the team (parallel)
- For independent slices, issue **multiple `Agent` calls in a single message** so they run
  concurrently, using the **specialist agents** where they match (see Operating rules). Use a
  named team (`TeamCreate` + `Agent` with `team_name`/`name`, monitored via
  `TaskList`/`TaskOutput`) when agents must coordinate live; otherwise plain concurrent
  `Agent` calls are simpler. Prefer disjoint file ownership over `isolation: "worktree"`.
- Every spawn prompt MUST include:
  1. The exact checklist item(s) the agent must satisfy, quoted from the plan file.
  2. Its **file ownership** and a hard rule: *do not modify files outside your slice.*
  3. The **relevant skills to invoke** and, for UI, the project aesthetic ("precision
     instrument": dark, technical, gauge-like score rings, monospace data accents — never
     Inter/generic shadcn defaults).
  4. The shared contract/seam it codes against and the architecture constraints from the plan
     (plus `.claude/rules/` invariants for its files — those load automatically on file match).
  5. Acceptance criteria: typechecks, lints, and **ships tests** for its slice.

### 5. Integrate & run the verification gate (your job, on red→iterate)
Run the full gate from the repo root and **iterate until all green**:
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm test`
- **The phase's `Gate` line from the plan, literally** — do the real check, not a proxy. Where
  a gate clause needs user-supplied credentials/infrastructure, mark it **blocked-on-user** in
  the report instead of attempting or faking it.
- For phases touching security-sensitive surfaces, run the `security-reviewer` agent and
  resolve its Critical/High findings before declaring green.

If an agent's slice fails the gate, fix it directly or send corrective instructions via
`SendMessage`. Resolve cross-slice conflicts yourself.

### 6. Update the plan file
Only after the gate is fully green (modulo explicitly blocked-on-user clauses):
- Flip every completed `[ ]` → `[x]` for the phase. Don't check items you didn't actually
  finish — partially blocked items stay unchecked with a brief inline note.
- Add/refresh a **Status** line in the plan's header block, e.g.
  `Status: Phase D complete — Ollama driver ships; OpenAI-compatible driver pending.`
- If the phase revealed a deviation from the plan, record it briefly rather than silently
  diverging.

### 7. Commit & push
Running this skill is the user's standing authorization to commit and push *this phase's* work.
- `git add -A` (mind the §1 warning about unrelated changes; hooks will block `.env*`/`.mcp.json`).
- Commit with a conventional message: `feat: complete Phase <X> — <phase title>` (use
  `chore:`/`fix:` when more apt), body listing the checklist items delivered, gate results,
  and any blocked-on-user clauses. **End the commit message with the standard co-author
  trailer for the current model** (e.g. `Co-Authored-By: Claude <model> <noreply@anthropic.com>`).
- `git push` to `origin` on the current branch. If the push is rejected (diverged),
  pull/rebase, re-run the gate, then push — never force-push without asking (a hook enforces
  this on `main`/`develop`).

### 8. Report & clean up
- `TeamDelete` any team you created.
- Summarize: phase completed, what now works, gate results (lint/typecheck/build/test/Gate),
  clauses blocked on user-supplied prerequisites, the commit hash, and **what the next phase in
  dependency order is** so the user can re-invoke `/next-phase` with the same plan file.

## Definition of done (all required)
1. Every targeted `[ ]` item implemented (or explicitly reported blocked-on-user).
2. Lint + typecheck + build + tests + the plan's **Gate** step all green for what is locally
   verifiable.
3. The plan file's checklist and Status updated truthfully.
4. Work committed (with co-author trailer) and pushed to `origin`.

## Notes
- This tool runs locally on macOS; Node v24 and Chrome are installed, so engine/UI gate steps
  run for real. Cross-OS gate clauses are blocked-on-user until VMs exist — report them, don't
  simulate them.
- Prefer doing the next single phase well over racing through several. If the user explicitly
  asks for multiple phases, do them **sequentially** (each fully through steps 3–7) — never run
  two dependency-ordered phases in parallel.
