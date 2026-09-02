# Security rules (always loaded)

- Never write real credentials into this repo — code, tests, fixtures, or docs. Example keys
  in docs must be truncated so they don't match live-key shapes. (PreToolUse hooks in
  `.claude/hooks/` enforce this deterministically — if one blocks you, fix the content, don't
  work around the hook.)
- `.env` and `.mcp.json` are machine-local: never stage or commit them. `.env.example` is the
  committed template and must contain no real values.
- Runtime secrets (Anthropic/provider keys, Google/PSI key) are read from `process.env`, normally
  a gitignored `.env`. This replaced OS-keychain storage when Electron was removed on 2026-09-02:
  the app now runs from the user's own source checkout, so `.env` is the conventional and adequate
  boundary. Secrets still must never reach SQLite, a COMMITTED file, logs, or the client bundle.
- Settings pages are **read-only status plus guidance** — they never accept, write, or echo a key,
  and status endpoints report presence as a boolean only.
- Only LightAudit's OWN credentials belong in `.env`. A third-party tool the app merely talks to
  (e.g. a research MCP server) owns its credentials — never read, store, or forward them.
- The local app server binds `127.0.0.1` only and requires the per-session auth token on
  every route.
- Any new license-cloud endpoint gets zod input validation and rate limiting by default;
  Stripe webhooks are always signature-verified and idempotent.
- There is NO Electron in this project — do not reintroduce it, or any packaging/signing step.
- After changing auth, secret handling, the middleware/session token, or the local HTTP server: have the `security-reviewer` agent review the diff before
  considering the work done.
