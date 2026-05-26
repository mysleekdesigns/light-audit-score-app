---
name: next-phase
description: Build the next unfinished phase of PRD.md using a parallel team of sub-agents, run the full verification gate until everything is green, check off the PRD checklist, then commit and push. Use when asked to "work on the next phase", "build/do the next phase", "advance the PRD", or via /next-phase. Accepts an optional phase number or range (e.g. /next-phase 2, /next-phase 4-5).
metadata:
  argument-hint: "[phase number or range — defaults to the next unfinished phase]"
  version: "1.0.0"
---

# next-phase

Drive the phased plan in `PRD.md` §6 to completion, one phase at a time, using a **parallel
team of sub-agents** for the independent work. A phase is only "done" when its checklist is
implemented, the **verification gate is green**, the PRD is updated, and the work is committed
and pushed.

This skill is the orchestrator. You (the main agent running this skill) own selection,
decomposition, integration, verification, the PRD update, and the git commit/push. Sub-agents
own implementation of disjoint slices. **Never delegate the verification gate or the commit** —
those are yours so the phase is judged by one consistent standard.

## Operating rules (read first)

- **One phase per invocation, in order.** Phases in `PRD.md` are dependency-ordered (Phase N
  builds on N-1). Default to the *first phase with unchecked `[ ]` items*. Do not start a later
  phase before earlier phases are complete. Only the *items within* a phase get parallelized.
- **Skills are binding for every agent** (per `CLAUDE.md`). You and every sub-agent MUST invoke
  the relevant skill when its trigger applies. Built-in Explore/Plan/general agents don't read
  `CLAUDE.md`, so **restate the applicable skills inside each spawn prompt** (belt-and-suspenders):
  - UI work → `frontend-design` (primary visual authority) + `vercel-react-best-practices` + `shadcn`, then review with `web-design-guidelines`.
  - Component APIs / the client·hook·contract seam → `vercel-composition-patterns`.
- **Don't fake completion.** If the gate fails, fix it or report the failure honestly — never
  check off a PRD item or commit on red.
- **Frontend-first** (per `CLAUDE.md`): build UI against the typed mock client/contract seam
  before wiring the real engine, when the phase allows it.

## Procedure

### 1. Preflight
- Confirm a git repo and capture the branch: `git rev-parse --is-inside-work-tree`,
  `git branch --show-current` (this repo: branch `develop`, remote `origin`). If on the
  default branch (`main`/`master`), create a feature branch first.
- `git status --short` — if there are unrelated uncommitted changes, surface them and ask
  before mixing them into this phase's commit.
- Read `PRD.md` (the §6 checklists) and `CLAUDE.md` (skills + conventions). Re-read each time;
  don't trust a stale memory of the phases.
- Load the orchestration tools you'll need:
  `ToolSearch select:TeamCreate,SendMessage,TaskList,TaskGet,TaskOutput,TeamDelete`.

### 2. Select the phase
- If the user passed a phase number/range, use it. Otherwise pick the **first phase in §6 with
  any unchecked `[ ]` item**. Greenfield → Phase 0.
- Quote the phase's title, its checklist items, and its **Verify** line back to the user in one
  short line so the scope is explicit before you spend effort.

### 3. Decompose into parallel workstreams
- Split the phase's checklist into the **fewest** workstreams that are genuinely independent,
  and assign each a **disjoint set of files/dirs** (no two agents write the same file). Shared
  contracts/types are written **first by you** (or one agent) so parallel agents can code against
  a stable seam.
- Keep tightly-coupled or ordering-sensitive bootstrap steps for yourself, done directly and
  first. Examples: `create-next-app`, `shadcn init`, installing deps, adding the Drizzle schema
  others import. Parallelize only what's safe to parallelize — correctness beats fan-out.
- Sketch the ownership map (agent → files → checklist items it satisfies) before spawning.

### 4. Spawn the team (parallel)
- For independent slices, issue **multiple `Agent` calls in a single message** so they run
  concurrently. Use a named team (`TeamCreate` + `Agent` with `team_name`/`name`, monitored via
  `TaskList`/`TaskOutput`) when agents must coordinate live; otherwise plain concurrent `Agent`
  calls are simpler. Consider `isolation: "worktree"` only for risky overlapping edits — prefer
  disjoint file ownership instead.
- Every spawn prompt MUST include:
  1. The exact checklist item(s) the agent must satisfy, quoted from the PRD.
  2. Its **file ownership** and a hard rule: *do not modify files outside your slice.*
  3. The **relevant skills to invoke** (restated from `CLAUDE.md`, see Operating rules) and the
     project aesthetic for UI ("precision instrument": dark, technical, gauge-like score rings,
     monospace data accents — never Inter/generic shadcn defaults).
  4. The shared contract/seam it codes against, and the stack constraints from `PRD.md` §5
     (Node runtime, `serverExternalPackages`, zod validation, Drizzle, etc.).
  5. Acceptance criteria: typechecks, lints, and **ships tests** for its slice.

### 5. Integrate & run the verification gate (your job, on red→iterate)
Run the full gate from the repo root and **iterate until all green**:
- `npm run lint`
- `tsc --noEmit` (or `npm run typecheck` if defined)
- `npm run build`
- `npm test` (or the project's test runner) — if the phase introduces logic, ensure tests exist.
- **The phase's PRD `Verify` line**, literally. E.g. Phase 1 → run `tsx scripts/audit-cli.ts <url>`
  and compare to `npx lighthouse <url>`; Phase 3 → launch the app (use the `run` skill) and drive
  a multi-URL audit in the browser. Do the real check the PRD asks for, not a proxy.

If an agent's slice fails the gate, fix it directly or send corrective instructions via
`SendMessage`. Resolve cross-slice conflicts yourself.

### 6. Update PRD.md
Only after the gate is fully green:
- Flip every completed `[ ]` → `[x]` for the phase (and its **Verify** line if the PRD lists it
  as checkable). Don't check items you didn't actually finish.
- Update the **Status** note near the top of `PRD.md` (the "Status: greenfield…" line in
  `CLAUDE.md`'s mirror lives in the PRD's framing) to reflect the highest completed phase, e.g.
  `Status: Phase N complete — <one-line summary of what now works>`.
- If the phase revealed a deviation from the plan, add a brief note rather than silently diverging.

### 7. Commit & push
Running this skill is the user's standing authorization to commit and push *this phase's* work.
- `git add -A` (mind the §2 warning about unrelated changes).
- Commit with a conventional message:
  `feat: complete Phase N — <phase title>` (use `chore:`/`fix:` when more apt), body listing the
  checklist items delivered and gate results. **End the commit message with:**
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- `git push` to `origin` on the current branch. If the push is rejected (diverged), pull/rebase,
  re-run the gate, then push — never force-push without asking.

### 8. Report & clean up
- `TeamDelete` any team you created.
- Summarize: phase completed, what now works, gate results (lint/build/test/Verify), the commit
  hash, and **what the next unfinished phase is** so the user can re-invoke `/next-phase`.

## Definition of done (all required)
1. Every targeted `[ ]` item implemented.
2. Lint + typecheck + build + tests + the PRD **Verify** step all green.
3. `PRD.md` checklist and Status updated truthfully.
4. Work committed (with co-author trailer) and pushed to `origin`.

## Notes
- This tool runs locally; Node v24 and Chrome are installed, so engine/UI Verify steps can run
  for real. If Chrome launch fails during Phase 1+ verification, treat it as a gate failure and
  surface the preflight error (see `PRD.md` §8).
- Prefer doing the next single phase well over racing through several. If the user explicitly
  asks for multiple phases, do them **sequentially** (each fully through steps 3–7) — never run
  two dependency-ordered phases in parallel.
