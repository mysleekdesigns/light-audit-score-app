#!/usr/bin/env node
// PreToolUse guard (Bash): deterministic protections for this repo.
//  - no force-push to main/develop (force-with-lease on feature branches is allowed)
//  - never stage .env* or .mcp.json (local-dev-only secrets; must never ship).
//    .env.example is exempt — it is the committed template (.claude/rules/security.md).
//  - no live credentials pasted into shell commands
// Exit 2 = block (stderr goes back to Claude as feedback).
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const cmd = String(input.tool_input?.command ?? "");
  if (!cmd) process.exit(0);

  const isForcePush =
    /\bgit\b[\s\S]*\bpush\b/.test(cmd) &&
    /(\s--force\b(?!-with-lease)|\s-f\b)/.test(cmd) &&
    /\b(main|master|develop)\b/.test(cmd);
  if (isForcePush) {
    console.error(
      "Blocked: force-pushing to main/develop is not allowed. Rebase/pull instead, " +
        "or ask the user explicitly (see .claude/skills/next-phase — never force-push without asking)."
    );
    process.exit(2);
  }

  if (/\bgit\s+add\b[^\n;|&]*(\.mcp\.json|\.env(?!\.example\b)(\.[A-Za-z0-9.]+)?\b)/.test(cmd)) {
    console.error(
      "Blocked: .mcp.json and .env files are local-dev-only and must never be staged or " +
        "committed (they hold machine paths and secrets; they never ship). " +
        ".env.example is the one exception — it is the committed template."
    );
    process.exit(2);
  }

  const secretPatterns = [
    [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
    [/sk_live_[A-Za-z0-9]{16,}/, "Stripe live secret key"],
    [/whsec_[A-Za-z0-9]{16,}/, "Stripe webhook signing secret"],
    [/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
    [/gh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  ];
  for (const [re, label] of secretPatterns) {
    if (re.test(cmd)) {
      console.error(
        `Blocked: this command contains what looks like a real ${label}. ` +
          `Never inline credentials in shell commands — read them from the environment or keychain.`
      );
      process.exit(2);
    }
  }
  process.exit(0);
});
