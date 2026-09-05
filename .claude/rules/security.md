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
  and status endpoints report presence as a boolean only. Non-secret preferences (the CrawlForge
  research switch) may be written to the `app_settings` table; nothing credential-shaped may.
- Only LightAudit Score's OWN credentials belong in `.env`. A third-party tool the app merely talks to
  (e.g. a research MCP server) owns its credentials — never read, store, or forward them.
  CrawlForge reads its own `~/.crawlforge/config.json`, which LightAudit Score existence-checks and
  never opens; its declaration carries no env secret. For a custom MCP config,
  `researchLaunchConfig` overlays only the `env` block the USER declared, at launch — and the
  Agent SDK passes that config on the `claude` command line, so never author a declaration that
  forwards a secret.
- The local app server binds `127.0.0.1` only and requires the per-install session token on
  every route. `scripts/start.mjs` resolves the token (`LH_SESSION_TOKEN`, else generated into
  `<data dir>/session-token`, mode 0600) and exports it; `src/proxy.ts` also refuses any
  `Host` header that is not loopback or in `LH_ALLOWED_HOSTS` (DNS-rebinding defence). Keep the
  gate's helpers in `src/lib/http/localGate.ts` dependency-free (no Node built-ins) and unit-tested; never reflect request
  data into the 401/403 bodies.
- There is NO Electron in this project — do not reintroduce it, or any packaging/signing step.
- After changing auth, secret handling, the proxy (request gate)/session token, or the local HTTP server: have the `security-reviewer` agent review the diff before
  considering the work done.
