import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the file-tracing root to THIS project dir. The repo contains a sibling
  // `cloud/` workspace, which otherwise makes Next/@vercel/nft infer a
  // multi-package workspace root and trace the whole repo. Pinning keeps the
  // trace honest and the build fast.
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
