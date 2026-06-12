---
paths:
  - "src/lib/db/**"
  - "drizzle/**"
  - "drizzle.config.ts"
---

# Database rules

- Schema changes go through Drizzle: edit `src/lib/db/schema.ts` → `npm run db:generate` →
  commit the generated migration under `drizzle/`. Never hand-edit an already-applied
  migration; add a new one.
- SQLite (better-sqlite3, WAL) is **permanent** for the desktop app — single user per
  machine; do not propose a Postgres migration here. Postgres exists only in the separate
  license-cloud codebase (SAAS_PLAN.md Phase B/F).
- All path resolution via `src/lib/db/paths.ts` (`LH_DATA_DIR`, `LH_DB_PATH`); in the
  packaged app these point at the OS app-data dir, so no assumptions about the repo layout.
- Tests must stay hermetic: point `LH_DATA_DIR`/`LH_DB_PATH` at temp dirs and use
  `resetDbForTests()` between cases (existing pattern in `src/lib/db/*.test.ts`).
