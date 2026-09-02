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
    // CI workflows are YAML, not linted here
    ".github/**",
    // The license cloud (SAAS_PLAN.md Phase B) is a self-contained app with its
    // own tooling under cloud/ — it is linted/typechecked/built by its own gate.
    "cloud/**",
  ]),
]);

export default eslintConfig;
