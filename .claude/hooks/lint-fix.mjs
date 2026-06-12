#!/usr/bin/env node
// PostToolUse (Edit|Write): auto-run `eslint --fix` on edited app TypeScript files.
// Exit 2 (with the eslint report on stderr) when unfixable problems remain, so
// Claude sees real lint errors immediately instead of at the verification gate.
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const file = input.tool_input?.file_path;
  const proj = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!file || !/\.(ts|tsx)$/.test(file)) process.exit(0);

  const rel = path.relative(proj, path.resolve(file));
  if (rel.startsWith("..")) process.exit(0); // outside the project (e.g. memory files)
  if (!/^(src|scripts)\//.test(rel)) process.exit(0); // only lint app code
  if (!fs.existsSync(path.resolve(proj, rel))) process.exit(0);

  const r = spawnSync("npx", ["eslint", "--fix", "--no-warn-ignored", rel], {
    cwd: proj,
    encoding: "utf8",
    timeout: 90_000,
  });
  if (r.error) process.exit(0); // eslint itself unavailable — don't block on tooling failure
  if (r.status !== 0) {
    const report = `${r.stdout || ""}${r.stderr || ""}`.trim().slice(0, 4000);
    console.error(
      `eslint found problems in ${rel} after auto-fix — fix these now:\n${report}`
    );
    process.exit(2);
  }
  process.exit(0);
});
