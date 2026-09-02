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
- **Web research is an OPTIONAL, vendor-neutral seam.** `loadResearchMcpConfig` reads a standard
  MCP config and launches the server the user declared (`mcpServers.research`, or the sole server,
  or `LH_RESEARCH_MCP_SERVER`). LightAudit **never bundles, installs, advertises, or credentials**
  a research server — it is separate software under the user's control. Do not add a product name
  to app code or UI copy, do not add a dependency on one, and do not store its API keys.
- `.mcp.json` stays local-dev-only and must never ship; the shipped path is a user-supplied config
  found via `LH_RESEARCH_MCP_CONFIG`.
- Research and the LLM are separate concerns: the MCP server does web research, the model may be
  Claude/Ollama/OpenAI-compatible. With no research server the analysis still diagnoses from the
  LHR and is badged ungrounded — it must never hard-error and must never nag.
- When working in this area, invoke the `byo-ai-providers` skill.
