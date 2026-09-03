---
name: next-phase
description: Build the next unfinished phase of SAAS_PLAN.md (the LightAudit launch plan, phases A–H) using a parallel team of sub-agents, run the full verification gate until everything is green, check off the plan's checklist, then commit and push. Use when asked to "work on the next phase", "build/do the next phase", "advance the plan", or via /next-phase. Accepts an optional phase letter or range (e.g. /next-phase B, /next-phase D-E) and an optional alternate plan file (e.g. /next-phase @PRD.md 3).
metadata:
  argument-hint: "[phase letter/number and/or plan file — defaults to SAAS_PLAN.md, next unfinished phase]"
  version: "2.0.0"
---

# next-phase

Drive the phased plan to completion, one phase at a time, using a **parallel team of
sub-agents** for the independent work. The plan is **`SAAS_PLAN.md` §5 (Roadmap, phases
A–H)** by default. If the argument names a different plan file (e.g. `/next-phase @PRD.md`),
use that file instead — every "SAAS_PLAN.md" instruction below then applies to it (its
checklists, its **Gate**/**Verify** lines, its checkbox flips, its status note). `PRD.md` §6
is the original build plan (phases 0–9, complete) and is only driven when explicitly named.

A phase is only "done" when its checklist is implemented, the **Gate is green**, the plan
file is updated, and the work is committed and pushed.

This skill is the orchestrator. You (the main agent running this skill) own selection,
decomposition, integration, verification, the plan update, and the git commit/push.
Sub-agents own implementation of disjoint slices. **Never delegate the verification gate or
the commit** — those are yours so the phase is judged by one consistent standard.

## Operating rules (read first)

- **One phase per invocation, dependency order per the plan.** SAAS_PLAN.md sequencing:
  **A → B → C** strictly ordered; **D** and **E** independently after C; **F** needs B + C;
  **G** needs everything except F; **H** is post-revenue. Default to the *first phase in that
  order with unchecked `[ ]` items*. Only the *items within* a phase get parallelized.
- **External prerequisites are reported, not faked.** SAAS_PLAN phases include things only
  the user can provide (Apple/Windows signing certs, Stripe account, deployed Vercel/Neon
  services, a second OS). Implement and verify everything locally verifiable; list the gate
  clauses that are blocked on user-supplied credentials/infrastructure explicitly in your
  report — never check them off, never silently skip them.
- **Skills are binding for every agent** (per `CLAUDE.md`). Restate the applicable skills in
  each spawn prompt (built-in Explore/Plan agents don't read `CLAUDE.md`):
  - UI work → `frontend-design` + `vercel-react-best-practices` + `shadcn`, review with `web-design-guidelines`.
  - Component APIs / contract seams → `vercel-composition-patterns`.
  - Phase D → `byo-ai-providers`.
- **Prefer the specialist sub-agents** in `.claude/agents/` over generic ones:
  `ai-provider-engineer` (D).
  After any phase touching auth, secrets, or the local server,
  run the read-only `security-reviewer` agent over the diff before the gate is called green.
- **Don't fake completion.** If the gate fails, fix it or report the failure honestly —
  never check off a plan item or commit on red.

## Procedure

### 1. Preflight
- Confirm a git repo and capture the branch: `git rev-parse --is-inside-work-tree`,
  `git branch --show-current` (this repo: branch `develop`, remote `origin`). If on the
  default branch (`main`/`master`), create a feature branch first.
- `git status --short` — if there are unrelated uncommitted changes, surface them and ask
  before mixing them into this phase's commit.
- Read `SAAS_PLAN.md` (§5 Roadmap checklists + the phase's Gate) and `CLAUDE.md` (skills +
  conventions). Re-read each time; don't trust a stale memory of the phases.
- Load the orchestration tools you'll need:
  `ToolSearch select:TeamCreate,SendMessage,TaskList,TaskGet,TaskOutput,TeamDelete`.

### 2. Select the phase
- If the user passed a phase letter/number or range, use it. Otherwise pick the **first
  phase in dependency order with any unchecked `[ ]` item** (greenfield SAAS plan → Phase A).
- Quote the phase's title, its checklist items, and its **Gate** line back to the user in one
  short line so the scope is explicit before you spend effort. Note any ⚠️ risk callout the
  plan attaches to the phase (e.g. Phase A: prototype forked-worker packaging first).

### 3. Decompose into parallel workstreams
- Split the phase's checklist into the **fewest** workstreams that are genuinely independent,
  and assign each a **disjoint set of files/dirs** (no two agents write the same file). Shared
  contracts/types are written **first by you** (or one agent) so parallel agents can code
  against a stable seam.
- Keep tightly-coupled or ordering-sensitive bootstrap steps for yourself, done directly and
  first (e.g. creating a shared schema,
  installing deps others import). Do the phase's flagged risk prototype before
  fanning out. Parallelize only what's safe — correctness beats fan-out.
- Sketch the ownership map (agent → files → checklist items it satisfies) before spawning.

### 4. Spawn the team (parallel)
- For independent slices, issue **multiple `Agent` calls in a single message** so they run
  concurrently, using the **specialist agents** where they match (see Operating rules). Use a
  named team (`TeamCreate` + `Agent` with `team_name`/`name`, monitored via
  `TaskList`/`TaskOutput`) when agents must coordinate live; otherwise plain concurrent
  `Agent` calls are simpler. Prefer disjoint file ownership over `isolation: "worktree"`.
- Every spawn prompt MUST include:
  1. The exact checklist item(s) the agent must satisfy, quoted from `SAAS_PLAN.md`.
  2. Its **file ownership** and a hard rule: *do not modify files outside your slice.*
  3. The **relevant skills to invoke** and, for UI, the project aesthetic ("precision
     instrument": dark, technical, gauge-like score rings, monospace data accents — never
     Inter/generic shadcn defaults).
  4. The shared contract/seam it codes against and the architecture constraints from
     `SAAS_PLAN.md` §4 (plus `.claude/rules/` invariants for its files).
  5. Acceptance criteria: typechecks, lints, and **ships tests** for its slice.

### 5. Integrate & run the verification gate (your job, on red→iterate)
Run the full gate from the repo root and **iterate until all green**:
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm test`
- **The phase's `Gate` line from `SAAS_PLAN.md`, literally** — do the real check, not a
  proxy (e.g. Phase A: packaged build runs a crawl audit + PSI audit with no terminal;
  Phase C: expired license degrades to read-only and recovers). Where a gate clause needs
  user-supplied credentials/infrastructure, mark it **blocked-on-user** in the report
  instead of attempting or faking it.
- For phases touching security-sensitive surfaces, run the `security-reviewer` agent and
  resolve its Critical findings before declaring green.

If an agent's slice fails the gate, fix it directly or send corrective instructions via
`SendMessage`. Resolve cross-slice conflicts yourself.

### 6. Update SAAS_PLAN.md
Only after the gate is fully green (modulo explicitly blocked-on-user clauses):
- Flip every completed `[ ]` → `[x]` for the phase. Don't check items you didn't actually
  finish — partially blocked items stay unchecked with a brief inline note.
- Add/refresh a **Status** line in the plan's header block (under the "Drafted…" note), e.g.
  `Status: Phase A complete — app packages and runs signed on macOS; Windows cert pending.`
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
  this on main/develop).

### 8. Report & clean up
- `TeamDelete` any team you created.
- Summarize: phase completed, what now works, gate results (lint/typecheck/build/test/Gate),
  clauses blocked on user-supplied prerequisites (certs, accounts, other OSes), the commit
  hash, and **what the next phase in dependency order is** so the user can re-invoke
  `/next-phase`.

## Definition of done (all required)
1. Every targeted `[ ]` item implemented (or explicitly reported blocked-on-user).
2. Lint + typecheck + build + tests + the plan's **Gate** step all green for what is locally
   verifiable.
3. `SAAS_PLAN.md` checklist and Status updated truthfully.
4. Work committed (with co-author trailer) and pushed to `origin`.

## Notes
- This tool runs locally on macOS; Node v24 and Chrome are installed, so engine/UI gate steps
  run for real. Cross-OS gate clauses (Windows/Linux installs) and signed-build clauses are
  blocked-on-user until certs/VMs exist — report them, don't simulate them.
- Prefer doing the next single phase well over racing through several. If the user explicitly
  asks for multiple phases, do them **sequentially** (each fully through steps 3–7) — never
  run two dependency-ordered phases in parallel. (D and E are the one documented pair that
  may be parallelized across invocations after C — still do one per invocation.)
