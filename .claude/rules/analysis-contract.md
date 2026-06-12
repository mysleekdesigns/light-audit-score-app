---
paths:
  - "src/lib/analysis/**"
  - "src/hooks/**"
  - "src/app/api/reports/**"
---

# AI analysis contract rules

- `AnalysisStreamEvent` (`src/lib/analysis/types.ts`) is a frozen contract: extend only
  additively; every provider/driver adapts to it; `useAnalysisStream` and the analysis UI
  panels must not require changes when providers are added (SAAS_PLAN.md Phase D).
- AI auth is always the **user's own**: Claude Code/Max login, BYO provider key, or local
  Ollama. Never introduce a LightAudit-owned API credential.
- Record provider/model on every analysis (`analyses.model`); analyses persist keyed
  `(runId, category)` via `src/lib/db/analyses.ts`.
- Fixes parse from `<<<FIXES_JSON>>>` markers — zod-validate, allow one repair/retry, then
  degrade to prose-only. Stream failures surface as `error` events, never unhandled crashes.
- The CrawlForge MCP (`.mcp.json`) is a local-dev research tool only — shipped builds use
  Agent SDK built-in web search/fetch instead. Don't deepen the dependency.
- When working in this area, invoke the `byo-ai-providers` skill.
