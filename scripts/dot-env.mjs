/**
 * Reading a `.env` file, without a dependency and without side effects.
 *
 * Extracted from `./session-token.mjs` in ROADMAP Phase G's security re-review
 * (M4): the MCP server needs the data-location variables out of `.env` — an
 * `LH_DATA_DIR` the app honours and the agent does not is two archives, which is
 * exactly the split Phase G exists to avoid — but it must not have an import
 * path to session-token code, since "requires no session token" is one of its
 * gate clauses.
 *
 * This is deliberately NOT a dotenv implementation. It reads `KEY=value` lines,
 * strips matched quotes, ignores comments and anything that is not a valid
 * identifier, and applies nothing to `process.env` — the caller decides which
 * keys it wants, which is what lets the MCP server take three of them and leave
 * every credential in the file alone.
 */

import { readFileSync } from "node:fs";

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
