---
paths:
  - "src/lib/analysis/**"
  - "src/hooks/**"
  - "src/app/api/reports/**"
---

# AI analysis contract rules

- `AnalysisStreamEvent` (`src/lib/analysis/types.ts`) is a frozen contract: extend only
  additively; every provider/driver adapts to it; `useAnalysisStream` and the analysis UI
  panels must not require changes when providers are added. See the `byo-ai-providers` skill.
- AI auth is always the **user's own**: Claude Code/Max login, BYO provider key, or local
  Ollama. Never introduce an API credential owned by LightAudit Score.
- Record provider/model on every analysis (`analyses.model`); analyses persist keyed
  `(runId, category)` via `src/lib/db/analyses.ts`.
- Fixes parse from `<<<FIXES_JSON>>>` markers — zod-validate, allow one repair/retry, then
  degrade to prose-only. Stream failures surface as `error` events, never unhandled crashes.
- **Web research is an OPTIONAL seam with one named option.** `resolveResearchServer`
  (`providers/researchMcp.ts`) picks, in order: **CrawlForge** when the user has switched it on in
  Settings AND a key is detectable (`providers/crawlforge.ts` — launched via `npx -y
  crawlforge-mcp-server`, off by default, credit-heavy tools listed in
  `CRAWLFORGE_DISALLOWED_TOOL_NAMES`); otherwise the server the user declared in a standard MCP
  config (`mcpServers.research`, or the sole server, or `LH_RESEARCH_MCP_SERVER`). LightAudit Score
  **never bundles, installs, or credentials** a research server — it is separate software under
  the user's control. CrawlForge is the only product name allowed in app code or UI copy; do not
  add a dependency on it (pinned `npx` spec only, bumped in reviewed commits), never enable it by
  default, and never read, store, or forward its API key — the server reads its own setup file,
  which LightAudit Score existence-checks and reports as a boolean. Declared `env` blocks reach the
  `claude` CLI on its command line, so no declaration LightAudit Score authors may carry a secret.
- `.mcp.json` stays local-dev-only and must never ship; the shipped path is a user-supplied config
  found via `LH_RESEARCH_MCP_CONFIG`.
- Research and the LLM are separate concerns: the MCP server does web research, the model may be
  Claude/Ollama/OpenAI-compatible. With no research server the analysis still diagnoses from the
  LHR and is badged ungrounded — it must never hard-error and must never nag.
- When working in this area, invoke the `byo-ai-providers` skill.
