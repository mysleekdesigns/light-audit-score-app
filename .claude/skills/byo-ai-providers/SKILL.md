---
name: byo-ai-providers
description: The BYO-AI provider seam for LightAudit's analysis engine — AnalysisProvider interface over src/lib/analysis/runAnalysis.ts via the Vercel AI SDK, Claude Agent-SDK / Ollama / OpenAI-compatible drivers, capability tiers and honest degradation, app-side web-search tool, structured-output repair, provider badging and settings UX. Use for SAAS_PLAN.md Phase D work or any change under src/lib/analysis/.
---

# BYO AI providers for LightAudit

Authoritative plan: `SAAS_PLAN.md` §4 ("BYO AI") + Phase D. Goal: analysis runs on the
**user's** AI — Claude plan, any provider key, or local Ollama — with **zero LightAudit-owned
AI credentials** shipped in or reachable from the app.

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

For shipped builds the CrawlForge MCP dependency is dropped: Claude-path research uses Agent
SDK built-in web search/fetch. `.mcp.json` (hardcoded paths + secrets) is local-dev-only and
must be excluded from packaging.

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
  override. Keys go to the OS keychain — never SQLite, never JSON on disk, never logged.
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
LHR-only fallback on a small local model; PSI on a user-created key; zero LightAudit-owned
credentials anywhere.
