#!/usr/bin/env node
// PreToolUse guard (Edit|Write): block file writes that would put live-looking
// credentials on disk. Exit 2 = block (stderr goes back to Claude as feedback).
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // malformed input — never block on our own failure
  }
  const t = input.tool_input ?? {};
  const text = [t.content, t.new_string].filter(Boolean).join("\n");
  if (!text) process.exit(0);

  const patterns = [
    [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
    [/sk_live_[A-Za-z0-9]{16,}/, "Stripe live secret key"],
    [/rk_live_[A-Za-z0-9]{16,}/, "Stripe live restricted key"],
    [/whsec_[A-Za-z0-9]{16,}/, "Stripe webhook signing secret"],
    [/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
    [/gh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key material"],
  ];

  for (const [re, label] of patterns) {
    if (re.test(text)) {
      console.error(
        `Blocked: the content being written matches a ${label} pattern. ` +
          `Real credentials must never be written into this repo — use the OS keychain at runtime ` +
          `and env vars locally (see .claude/rules/security.md). If this is a deliberately fake ` +
          `fixture, truncate it so it no longer matches a live-key pattern.`
      );
      process.exit(2);
    }
  }
  process.exit(0);
});
