/**
 * Minimal ESM resolve hook so the standalone audit CLI can run under Node's
 * native TypeScript type-stripping (Node 24) while keeping the project's `@/*`
 * path alias (→ `./src/*`, see tsconfig.json) and its extensionless imports.
 *
 * Why not `tsx`? tsx transpiles with esbuild's `keepNames: true` (hardcoded),
 * which injects `__name(...)` wrappers into Lighthouse's source. Lighthouse
 * serializes some of those functions (e.g. `computeBenchmarkIndex`) and evaluates
 * them in the browser page, where `__name` is undefined → "ReferenceError:
 * __name is not defined". Node's native type-stripping does no such transform,
 * so Lighthouse runs correctly. This hook just teaches Node to resolve the two
 * import styles the app's TypeScript is written in.
 *
 * Both styles need the same treatment, and for the same reason: the app is
 * written for a bundler (`moduleResolution: "bundler"`), which invents an
 * extension, while Node's ESM resolver demands one. `@/x` covers most of `src/`,
 * but a module that imports a sibling as `./x` — `src/lib/crawl/*` does — fails
 * identically once a script reaches it, so relative specifiers get the same
 * extension resolution rather than a second workaround later.
 *
 * The relative branch is confined to the project's OWN files (`isProjectFile`).
 * That is not tidiness: this hook also intercepts CommonJS `require()`, in every
 * dependency, and rewriting there crashes the process. See `isProjectFile`.
 *
 * Usage: node --import ./scripts/alias-hooks.mjs scripts/audit-cli.ts <url>
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcDir = path.resolve(fileURLToPath(import.meta.url), "../../src");
const projectRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const nodeModules = `${path.sep}node_modules${path.sep}`;

/**
 * Whether a relative import came from THIS PROJECT'S OWN TypeScript, as opposed
 * to from a dependency.
 *
 * This gate is load-bearing, and its absence was a real bug (ROADMAP Phase F
 * security review, H1). `registerHooks` intercepts CommonJS `require()` as well
 * as ESM `import`, and `parentURL` is a `file:` URL for every file on disk —
 * `node_modules` included. So an unguarded relative branch also rewrote
 * `require("./x")` inside dependencies, and a hit was not merely wrong but
 * FATAL: the rewritten value is a `file://` href, which `Module._resolveFilename`
 * cannot consume, so the process died with `Cannot find module 'file:///…'`.
 * Since this hook rides the forked audit worker's `execArgv`, that would have
 * been every audit, including from the web UI — one `npm install` away, in a
 * package nobody edited.
 *
 * Only the app's own source is written for a bundler and therefore needs the
 * extension invented; a dependency ships whatever Node already understands. So
 * the rewrite is confined to files under the project root and outside
 * `node_modules`, which is exactly the set with the problem.
 */
function isProjectFile(filePath) {
  return (
    filePath.startsWith(`${projectRoot}${path.sep}`) &&
    !filePath.includes(nodeModules)
  );
}

/**
 * Add the `.ts` extension Node's native resolver requires (bundler-style
 * extensionless imports aren't supported natively). Returns the path unchanged
 * when it already has an extension or when no TypeScript file matches, so a
 * genuine miss still fails with Node's own error rather than a rewritten one.
 */
function withTsExtension(target) {
  if (path.extname(target)) return target;
  if (existsSync(`${target}.ts`)) return `${target}.ts`;
  if (existsSync(path.join(target, "index.ts"))) {
    return path.join(target, "index.ts");
  }
  return target;
}

// Synchronous, in-thread hook (Node 24). Resolves `@/x` → `<src>/x(.ts)` and
// `./x` → `<importer dir>/x.ts`; everything else (bare package specifiers,
// `node:*`) passes straight through to the default resolver.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = withTsExtension(path.join(srcDir, specifier.slice(2)));
      return nextResolve(pathToFileURL(target).href, context);
    }
    // Extensionless relative imports, but ONLY from the project's own source —
    // see `isProjectFile`. A relative specifier from anywhere else, most of all
    // from inside `node_modules`, is the default resolver's business.
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:") &&
      !path.extname(specifier)
    ) {
      const parent = fileURLToPath(context.parentURL);
      if (isProjectFile(parent)) {
        const target = withTsExtension(
          path.resolve(path.dirname(parent), specifier),
        );
        // Only when a `.ts` actually matched; otherwise fall through so a
        // genuine miss fails with Node's own error rather than a rewritten one.
        if (path.extname(target)) {
          return nextResolve(pathToFileURL(target).href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
