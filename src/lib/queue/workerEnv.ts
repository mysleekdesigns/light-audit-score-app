/**
 * The environment the forked audit worker — and therefore Chrome — is given.
 *
 * `.claude/rules/engine-workers.md` already reasons this through for one value:
 * a process environment is readable by anything running as the same user and is
 * inherited by every descendant, and this worker launches Chrome, so an
 * env-borne credential lands in the environment of the process rendering
 * untrusted web content. That is why audit credentials travel over IPC.
 *
 * The fork nevertheless copied the WHOLE parent environment, which was
 * defensible while every parent was ours: `next start` and `npm run ci` are
 * launched by the user, from a shell they control, to audit pages they named.
 * ROADMAP Phase G changed the parent (security re-review, M3). An MCP server is
 * launched by a coding agent, whose environment conventionally carries provider
 * API keys — and the pages it audits are chosen by a model that reads the web.
 * Copying that environment into Chrome is a needless hop for exactly the class
 * of secret the rule was written about.
 *
 * So the worker gets an allow-list. The trade is real and worth naming: an
 * allow-list can omit something a particular machine needs, and the failure —
 * Chrome not launching — is loud but confusing. `LH_WORKER_ENV_PASSTHROUGH`
 * exists for that, and the list below is deliberately generous about everything
 * that is not a secret: the tool's own configuration, the platform's process
 * plumbing, locale, temp directories, X11, and proxy settings, which a corporate
 * network needs and which name a host rather than authorise anything.
 */

/**
 * Exact variable names that cross into the worker.
 *
 * Grouped by why they are here, because the reason is what a future reader needs
 * when deciding whether to add one.
 */
const ALLOWED_NAMES: readonly string[] = [
  // Process plumbing: without these a fork cannot resolve a binary or a home.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  // Temp directories — chrome-launcher writes its throwaway profile here.
  "TMPDIR",
  "TMP",
  "TEMP",
  // Locale and time: a Lighthouse run's rendering and timestamps depend on them.
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // Chrome discovery and the display it draws on (X11/Wayland, headful Linux).
  "CHROME_PATH",
  "CHROME_PATHS",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  // Windows: cmd/Node need these to start a process at all.
  "SystemRoot",
  "SystemDrive",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROGRAMDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "NUMBER_OF_PROCESSORS",
  "OS",
  // Node's own runtime knobs. NODE_OPTIONS is deliberately ABSENT: it can inject
  // a module into the child, which is the one thing an allow-list should not
  // forward on someone else's behalf.
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  // Proxies. These name a host; they authorise nothing, and a machine behind a
  // corporate proxy cannot audit anything without them.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

/**
 * Prefixes that cross wholesale.
 *
 * `LH_` is the application's own namespace, and it must pass: the worker reads
 * its input, its output path and its host-scoped `.env` credentials from there
 * (`resolveEngineCredentials`), and the data-directory overrides live there too.
 * That is the one prefix where a secret legitimately travels by environment, and
 * it does so because the user set it for this tool, not because it happened to
 * be in the shell.
 */
const ALLOWED_PREFIXES: readonly string[] = ["LH_"];

/** Variable naming extra names to forward, comma-separated. */
export const PASSTHROUGH_VAR = "LH_WORKER_ENV_PASSTHROUGH";

/** Whether a name is allowed through, before the passthrough list is consulted. */
function isAllowed(name: string, extra: ReadonlySet<string>): boolean {
  if (extra.has(name)) return true;
  // Windows environment variables are case-insensitive, and Node preserves
  // whatever case the parent used, so the comparison has to be too. On POSIX the
  // names above are already the canonical spelling, so this only ever widens a
  // match that would otherwise fail for a cosmetic reason.
  const upper = name.toUpperCase();
  if (ALLOWED_NAMES.some((allowed) => allowed.toUpperCase() === upper)) return true;
  return ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Filter a parent environment down to what the worker needs.
 *
 * Pure, and takes the source environment rather than reading `process.env`, so
 * the policy is testable without a fork.
 */
export function filterWorkerEnv(
  // A plain record rather than `NodeJS.ProcessEnv`: Next's ambient types make
  // `NODE_ENV` a REQUIRED member of that interface, which would force every test
  // case and every caller to carry a key this function has no opinion about.
  // `process.env` is assignable to this.
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const extra = new Set(
    (source[PASSTHROUGH_VAR] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );

  // Built as a plain record and cast once at the end: Next's ambient types
  // declare `NODE_ENV` as a REQUIRED member of `ProcessEnv`, so an incrementally
  // filled `ProcessEnv` cannot typecheck until it happens to contain that key.
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isAllowed(name, extra)) filtered[name] = value;
  }
  return filtered as NodeJS.ProcessEnv;
}
