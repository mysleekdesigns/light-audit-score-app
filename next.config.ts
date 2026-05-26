import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lighthouse, chrome-launcher and better-sqlite3 are native / ESM-heavy packages
  // that must NOT be bundled by Next — they run in the Node runtime only.
  // See PRD §5 ("Critical Next.js config").
  serverExternalPackages: ["lighthouse", "chrome-launcher", "better-sqlite3"],
};

export default nextConfig;
