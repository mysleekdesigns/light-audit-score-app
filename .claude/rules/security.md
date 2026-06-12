# Security rules (always loaded)

- Never write real credentials into this repo — code, tests, fixtures, or docs. Example keys
  in docs must be truncated so they don't match live-key shapes. (PreToolUse hooks in
  `.claude/hooks/` enforce this deterministically — if one blocks you, fix the content, don't
  work around the hook.)
- `.mcp.json` and `.env*` are local-dev-only: never stage, commit, or reference them in any
  packaging/build config. They must never ship (SAAS_PLAN.md Phases D & E).
- Runtime secrets (license token, Anthropic/provider keys, Google key) belong in the OS
  keychain (Keychain/DPAPI/libsecret/`safeStorage`) — never SQLite, never plaintext files,
  never logs.
- The local app server binds `127.0.0.1` only and requires the per-session auth token on
  every route.
- Any new license-cloud endpoint gets zod input validation and rate limiting by default;
  Stripe webhooks are always signature-verified and idempotent.
- Electron windows: `contextIsolation: true`, `nodeIntegration: false`, validated deep-link
  input — no exceptions without an explicit note in SAAS_PLAN.md.
- After changing license checks, auth, billing, secret handling, Electron config, deep links,
  or the local HTTP server: have the `security-reviewer` agent review the diff before
  considering the work done.
