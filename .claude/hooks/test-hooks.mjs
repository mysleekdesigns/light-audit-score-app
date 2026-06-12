#!/usr/bin/env node
// Self-test for the guard hooks. Payload strings are assembled from parts so that
// running or writing this file doesn't itself trip the guards.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const run = (script, payload) =>
  spawnSync("node", [path.join(here, script)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  }).status;

const fakeAnthropicKey = "sk-ant-" + "a".repeat(30);
const fakeStripeKey = "sk" + "_live_" + "b".repeat(24);
const forcePush = ["git", "push", "--for" + "ce", "origin", "develop"].join(" ");
const leasePush = ["git", "push", "--for" + "ce-with-lease", "origin", "feat/x"].join(" ");
const stageMcp = ["git", "add", ".mcp" + ".json"].join(" ");

const cases = [
  ["guard-secrets blocks Anthropic key", "guard-secrets.mjs", { tool_input: { content: `const k = "${fakeAnthropicKey}"` } }, 2],
  ["guard-secrets blocks Stripe live key", "guard-secrets.mjs", { tool_input: { new_string: fakeStripeKey } }, 2],
  ["guard-secrets passes clean content", "guard-secrets.mjs", { tool_input: { content: "const safe = 1;" } }, 0],
  ["guard-bash blocks force-push to develop", "guard-bash.mjs", { tool_input: { command: forcePush } }, 2],
  ["guard-bash allows force-with-lease on branch", "guard-bash.mjs", { tool_input: { command: leasePush } }, 0],
  ["guard-bash blocks staging .mcp.json", "guard-bash.mjs", { tool_input: { command: stageMcp } }, 2],
  ["guard-bash blocks key in command", "guard-bash.mjs", { tool_input: { command: `curl -H "x-api-key: ${fakeAnthropicKey}"` } }, 2],
  ["guard-bash passes normal command", "guard-bash.mjs", { tool_input: { command: "npm run lint" } }, 0],
  ["lint-fix skips non-TS file", "lint-fix.mjs", { tool_input: { file_path: "/tmp/notes.md" } }, 0],
  ["lint-fix skips file outside project", "lint-fix.mjs", { tool_input: { file_path: "/tmp/x.ts" } }, 0],
];

let failed = 0;
for (const [name, script, payload, want] of cases) {
  const got = run(script, payload);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} (exit ${got}, want ${want})`);
}
process.exit(failed ? 1 : 0);
