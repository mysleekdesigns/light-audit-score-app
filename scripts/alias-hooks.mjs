/**
 * Minimal ESM resolve hook so the standalone audit CLI can run under Node's
 * native TypeScript type-stripping (Node 24) while keeping the project's `@/*`
 * path alias (→ `./src/*`, see tsconfig.json).
 *
 * Why not `tsx`? tsx transpiles with esbuild's `keepNames: true` (hardcoded),
 * which injects `__name(...)` wrappers into Lighthouse's source. Lighthouse
 * serializes some of those functions (e.g. `computeBenchmarkIndex`) and evaluates
 * them in the browser page, where `__name` is undefined → "ReferenceError:
 * __name is not defined". Node's native type-stripping does no such transform,
 * so Lighthouse runs correctly. This hook just teaches Node to resolve `@/`.
 *
 * Usage: node --import ./scripts/alias-hooks.mjs scripts/audit-cli.ts <url>
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcDir = path.resolve(fileURLToPath(import.meta.url), "../../src");

// Synchronous, in-thread hook (Node 24). Resolves `@/x` → `<src>/x(.ts)`;
// everything else passes straight through to the default resolver.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      let target = path.join(srcDir, specifier.slice(2));
      // Add the .ts extension Node's native resolver requires (bundler-style
      // extensionless imports aren't supported natively).
      if (!path.extname(target)) {
        if (existsSync(`${target}.ts`)) target = `${target}.ts`;
        else if (existsSync(path.join(target, "index.ts"))) {
          target = path.join(target, "index.ts");
        }
      }
      return nextResolve(pathToFileURL(target).href, context);
    }
    return nextResolve(specifier, context);
  },
});
