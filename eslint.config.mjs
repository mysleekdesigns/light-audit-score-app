import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Electron main-process files are plain CJS Node.js (not TypeScript / ESM).
    // They intentionally use require() and are excluded from the TS/ESM lint rules.
    "electron/**/*.js",
    // Compiled worker output (generated artifact, not source)
    "scripts/audit-worker.js",
    // CI release workflow is YAML, not linted here
    ".github/**",
    // electron-builder output directory — never lint build artifacts
    "dist/**",
    // The license cloud (SAAS_PLAN.md Phase B) is a self-contained app with its
    // own tooling under cloud/ — it is linted/typechecked/built by its own gate.
    "cloud/**",
  ]),
]);

export default eslintConfig;
