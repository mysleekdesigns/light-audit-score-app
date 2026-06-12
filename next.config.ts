import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for Electron packaging (SAAS_PLAN.md Phase A).
  // Produces .next/standalone/server.js + a minimal node_modules copy.
  // The Electron main process spawns this as a child server process.
  // NOTE: after `next build`, copy .next/static/ and public/ into
  // .next/standalone/.next/static/ and .next/standalone/public/ respectively
  // (standalone output does not include them — handled by electron:build script).
  output: "standalone",

  // Pin the file-tracing root to THIS project dir (SAAS_PLAN.md Phase A; security
  // review). The repo contains a sibling `cloud/` license-server workspace, which
  // makes Next/@vercel/nft infer a *multi-package workspace* root and trace the
  // WHOLE repo root — copying `cloud/` (license-server source), `src/`, the design
  // docs (SAAS_PLAN.md / PRD.md / CLAUDE.md), `.env`, `.mcp.json`, lockfiles and
  // config files into `.next/standalone/`, all of which then ship in the client
  // `app.asar`. Pinning the trace root to import.meta.dirname stops the tracer
  // climbing out of this app. (prepare-package.mjs also hard-scrubs these as the
  // authoritative defence — this just keeps the trace honest at the source.)
  outputFileTracingRoot: path.join(import.meta.dirname),

  // Lighthouse, chrome-launcher and better-sqlite3 are native / ESM-heavy packages
  // that must NOT be bundled by Next — they run in the Node runtime only.
  // See PRD §5 ("Critical Next.js config").
  //
  // @anthropic-ai/claude-agent-sdk powers the AI score-analysis feature: it spawns
  // the Claude Code subprocess and ships a large bundled `.mjs`, so — like
  // lighthouse — it must stay external (never bundled) and run server-side only.
  serverExternalPackages: [
    "lighthouse",
    "chrome-launcher",
    "better-sqlite3",
    "@anthropic-ai/claude-agent-sdk",
  ],
};

export default nextConfig;
