/**
 * The local server's per-install session token — resolved by `scripts/start.mjs`
 * and handed to the server as `LH_SESSION_TOKEN`, which `src/middleware.ts`
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

/** What a persisted token must look like to be trusted (base64url, ≥ 32 chars). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,}$/;
/** The least a user-pinned token may be: 32+ characters, no whitespace. */
const MIN_PINNED_LENGTH = 32;

/**
 * A minimal `.env` reader — `KEY=value` lines, optional single/double quotes,
 * `#` comments — for the handful of keys the start script needs before Next
 * loads the file itself. No variable expansion, no `.env.local` layering.
 */
export function readDotEnv(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }

  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    values[key] = value;
  }
  return values;
}

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
          `(got ${explicit.length}). Unset it to let LightAudit generate one.`,
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
