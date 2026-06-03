import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
