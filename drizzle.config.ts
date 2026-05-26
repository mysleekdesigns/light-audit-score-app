/**
 * drizzle-kit config (PRD §6 Phase 4).
 *
 * Generates SQL migrations from `src/lib/db/schema.ts` into `./drizzle`. The app
 * applies those migrations at runtime on first DB access (see
 * `src/lib/db/client.ts`), so `npm run db:generate` is the only manual step when
 * the schema changes. The local SQLite file lives under `./data/` (gitignored).
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: "./data/lighthouse.db" },
});
