---
name: byo-ai-providers
description: The BYO-AI provider seam for LightAudit Score's analysis engine — AnalysisProvider interface over src/lib/analysis/runAnalysis.ts via the Vercel AI SDK, Claude Agent-SDK / Ollama / OpenAI-compatible drivers, capability tiers and honest degradation, app-side web-search tool, structured-output repair, provider badging and settings UX. Use for any BYO-AI provider work or change under src/lib/analysis/.
---

# BYO AI providers for LightAudit Score

This skill is the authoritative spec for the provider seam; `PRD.md` carries product intent.
(`SAAS_PLAN.md` was removed from the repo on 2026-09-02 — don't look for it.) Goal: analysis
runs on the **user's** AI — Claude plan, any provider key, or local Ollama — with **zero AI
credentials owned by LightAudit Score** anywhere in or reachable from the app.

## The frozen contract

`AnalysisStreamEvent` (union in `src/lib/analysis/types.ts`: status / tool-use / tool-result /
text-delta / fix / done / error) is the seam everything hangs off. Rules:
- Every driver adapts TO this contract; extend only additively.
- `useAnalysisStream` and the analysis UI panels must not change when a driver is added.
- The SSE route (`/api/reports/[runId]/analyze`) stays the single transport.
- Persistence stays keyed `(runId, category)` in `analyses`; record provider/model in the
  existing `analyses.model` column on every run; UI badges it.

## Drivers (implement with the Vercel AI SDK where possible)

1. **Claude (premium path)** — today's Agent SDK mechanism unchanged: user's Claude Code/Max
   login or BYO `ANTHROPIC_API_KEY`; keeps built-in web research + citations.
   ⚠️ **Blocking item:** verify Anthropic's current terms for third-party apps using
   subscription auth; adopt "Sign in with Claude" if GA. Surface this status in any Phase D
   report — never bury it.
2. **Ollama (local/private)** — auto-detect `http://localhost:11434` (configurable), list
   installed models for the picker, stream, and capability-probe (tool use? context length?).
3. **OpenAI-compatible** — base URL + API key + model name; presets for OpenAI, Gemini
   (compat endpoint), OpenRouter, LM Studio; covers vLLM by construction.

Web research is a separate seam (`src/lib/analysis/providers/researchMcp.ts`): the Claude
driver's built-in WebSearch/WebFetch stay disallowed, and research comes from a research MCP
server — **CrawlForge** as the one named, opt-in option (Settings switch, off by default,
launched via `npx` on demand; `providers/crawlforge.ts`), or any server the user declares in a
standard MCP config. `.mcp.json` is local-dev-only and never ships.

## Capability tiers — degrade honestly

| Tier | Condition | Behavior |
|---|---|---|
| Cited fixes | Claude path | built-in web research + citations |
| Cited fixes | non-Claude, tool-capable | app-side web-search tool on the user's own Google key |
| LHR-only | no reliable tool use (small local models) | data-only diagnosis, badged "no web research" |
| Prose-only | structured output unparseable after repair | diagnosis without fix cards |

Structured output: fixes parse from `<<<FIXES_JSON>>>` markers → zod-validate → one
repair/retry pass for weaker models → degrade to prose-only. Never crash the stream; emit
`error` events through the contract.

## Settings & UX rules

- Provider settings: Claude / Ollama / Custom; "test connection" button; per-analysis
  override. Settings panels are **read-only status plus guidance** — they never accept, write,
  or echo a key, and status endpoints report presence as a boolean only. Keys are read from
  `process.env` (a gitignored `.env`) — never SQLite, never JSON on disk, never logged, never
  in the client bundle.
- Detection-first auth UX: existing Claude Code login → one-click connect; running Ollama →
  suggest it; else offer sign-in / key / custom endpoint.
- No AI configured = a feature card explaining the options (not an error). User rate limits
  (Claude 5-hour window) = friendly retry message.
- Maintain a recommended-models list in docs (which Ollama models analyze well; minimum
  context length).
- UI work here follows CLAUDE.md skills: `frontend-design` + `shadcn` +
  `vercel-react-best-practices`, reviewed with `web-design-guidelines`.

## Phase D gate (what "done" means)

End-to-end analysis on all four paths — (a) Claude login, (b) pasted Anthropic key, (c) local
Ollama model, (d) OpenAI-compatible endpoint; cited fixes on tool-capable paths; badged
LHR-only fallback on a small local model; PSI on a user-created key; zero credentials owned by
LightAudit Score anywhere.
