/**
 * The local server's per-install session token — resolved by `scripts/start.mjs`
 * and handed to the server as `LH_SESSION_TOKEN`, which `src/proxy.ts`
 * requires on every route.
 *
 * Resolution order:
 *   1. `LH_SESSION_TOKEN` in the shell environment, or in `.env`;
 *   2. the token persisted in `<data dir>/session-token` by an earlier start;
 *   3. a fresh 256-bit token, generated and persisted (mode 0600) for next time.
 *
 * Persisting it keeps the printed link — and the browser cookie — valid across
 * restarts, so a bookmarked tab keeps working. The file lives beside the SQLite
 * DB, which is already gitignored and machine-local.
 *
 * Plain ESM so the start script can use it before anything is built; tests run
 * it directly.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

/** Filename under the data dir. */
export const SESSION_TOKEN_FILE = "session-token";

// `readDotEnv` moved to `./dot-env.mjs` (ROADMAP Phase G security re-review, M4)
// so the MCP server can read the data-location variables from `.env` WITHOUT
// importing this module. That server must not require or expose the session
// token; the cleanest way to keep that true is for it to have no import path to
// the code that resolves one. Re-exported here because `start.mjs` and this
// module's tests have always read it from this file.
export { readDotEnv } from "./dot-env.mjs";

/** What a persisted token must look like to be trusted (base64url, ≥ 32 chars). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,}$/;
/** The least a user-pinned token may be: 32+ characters, no whitespace. */
const MIN_PINNED_LENGTH = 32;

/**
 * Resolve the session token. Returns `{ token, source }` where `source` is
 * `"env"` (explicitly configured), `"file"` (persisted earlier) or
 * `"generated"` (new this start, now persisted).
 *
 * Throws when a pinned `LH_SESSION_TOKEN` is too weak to be a credential —
 * refusing to start beats printing a one-character "secret" as if it were one.
 */
export function resolveSessionToken({ env, dotEnv, dataDir }) {
  const explicit = env.LH_SESSION_TOKEN?.trim() || dotEnv.LH_SESSION_TOKEN?.trim();
  if (explicit) {
    if (explicit.length < MIN_PINNED_LENGTH || /\s/.test(explicit)) {
      throw new Error(
        `LH_SESSION_TOKEN must be at least ${MIN_PINNED_LENGTH} characters with no whitespace ` +
          `(got ${explicit.length}). Unset it to let LightAudit Score generate one.`,
      );
    }
    return { token: explicit, source: "env" };
  }

  const file = path.join(dataDir, SESSION_TOKEN_FILE);
  try {
    const stored = readFileSync(file, "utf8").trim();
    if (TOKEN_SHAPE.test(stored)) return { token: stored, source: "file" };
  } catch {
    // No persisted token yet — generate one below.
  }

  const token = randomBytes(32).toString("base64url");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    // `mode` only applies on creation; make sure a pre-existing file tightens too.
    chmodSync(file, 0o600);
  } catch {
    // Best effort (Windows has no POSIX modes).
  }
  return { token, source: "generated" };
}
