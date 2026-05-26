/**
 * `robots.txt` fetching + parsing for the discovery engine (PRD §6 Phase 5).
 *
 * Discovery crawls arbitrary sites, so it MUST be a polite robot: before
 * following a link we ask the parsed robots rules whether our user-agent is
 * allowed to fetch that path. This module owns that concern in isolation so the
 * orchestration in `discover.ts` stays readable and so the matcher can be
 * unit-tested without any network.
 *
 * Design notes / scope (deliberately a *practical* subset of the spec):
 *  - We resolve the rule group for our constant UA ({@link ROBOTS_USER_AGENT}),
 *    falling back to the `*` (wildcard) group when no UA-specific group exists.
 *  - Precedence: the most specific rule wins, measured by matched-pattern
 *    length (longest match), with `Allow` beating `Disallow` on an exact tie.
 *    This is the de-facto Google behaviour and is correct for the common cases
 *    we care about; we intentionally don't implement every RFC 9309 edge.
 *  - `*` (any run of chars) and `$` (end-of-path anchor) wildcards are honoured.
 *  - A missing / unfetchable / non-200 robots.txt means "allow everything":
 *    discovery is best-effort and a fetch failure must never be fatal.
 *
 * Kept dependency-free (no node:*, no third-party): it only parses a string and
 * uses the global `fetch`, so it's import-safe and trivially testable.
 */

/** The user-agent token we identify as when matching robots groups. */
export const ROBOTS_USER_AGENT = "LighthouseAuditBot";

/** Per-request fetch timeout (ms) — a hostile/slow host must not hang us. */
const ROBOTS_FETCH_TIMEOUT_MS = 10_000;

/** A single path rule extracted from a robots group. */
interface RobotsRule {
  /** `true` for `Allow:`, `false` for `Disallow:`. */
  allow: boolean;
  /** The raw path pattern (may contain `*` / `$`). */
  pattern: string;
}

/**
 * Parsed, queryable robots rules for our user-agent. Produced by
 * {@link parseRobots} and consumed by `discover.ts`.
 */
export interface RobotsMatcher {
  /** Whether our UA may fetch `pathname` (with optional query). Default: allow. */
  isAllowed(pathname: string): boolean;
  /** Absolute `Sitemap:` URLs declared anywhere in the file (deduped, in order). */
  sitemaps: string[];
}

/** A matcher that allows everything and declares no sitemaps. */
function allowAllMatcher(sitemaps: string[] = []): RobotsMatcher {
  return { isAllowed: () => true, sitemaps };
}

/**
 * Convert a robots path pattern (`*` wildcard, `$` end-anchor) into a RegExp.
 * Everything else is matched literally. An empty `Disallow:` pattern means
 * "disallow nothing" and is handled by the caller (it's dropped during parse).
 */
function patternToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      out += ".*";
    } else if (ch === "$" && i === pattern.length - 1) {
      out += "$";
    } else {
      // Escape regex metacharacters so the rest is matched literally.
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}`);
}

/**
 * Parse robots.txt text into a {@link RobotsMatcher} for {@link ROBOTS_USER_AGENT}.
 *
 * The grouping rule: directives belong to the most recent run of `User-agent:`
 * lines. We collect the rules for groups whose UA token is our UA or `*`, then
 * prefer the UA-specific group if present (Google's "most specific match wins"
 * for UA selection). `Sitemap:` is a top-level directive (group-independent).
 */
export function parseRobots(text: string): RobotsMatcher {
  const lines = text.split(/\r?\n/);

  // Rules keyed by the lowercased UA token they apply to.
  const groupRules = new Map<string, RobotsRule[]>();
  const sitemaps: string[] = [];
  const seenSitemaps = new Set<string>();

  // UA tokens for the group currently being read. A new `User-agent:` after a
  // non-UA directive starts a fresh group.
  let currentAgents: string[] = [];
  let sawDirectiveSinceAgent = false;

  for (const rawLine of lines) {
    // Strip comments and surrounding whitespace.
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (sawDirectiveSinceAgent) {
        // Previous group is closed; this UA begins a new group.
        currentAgents = [];
        sawDirectiveSinceAgent = false;
      }
      currentAgents.push(value.toLowerCase());
      if (!groupRules.has(value.toLowerCase())) {
        groupRules.set(value.toLowerCase(), []);
      }
      continue;
    }

    if (field === "sitemap") {
      // Sitemap is global, not tied to a UA group.
      if (value && !seenSitemaps.has(value)) {
        seenSitemaps.add(value);
        sitemaps.push(value);
      }
      continue;
    }

    if (field === "allow" || field === "disallow") {
      sawDirectiveSinceAgent = true;
      // `Disallow:` with an empty value disallows nothing — skip it.
      if (field === "disallow" && value === "") continue;
      if (value === "") continue;
      const rule: RobotsRule = { allow: field === "allow", pattern: value };
      for (const agent of currentAgents) {
        groupRules.get(agent)?.push(rule);
      }
    }
    // Unknown fields (Crawl-delay, Host, …) are ignored.
  }

  // Select the applicable rule set: our UA, else the wildcard group.
  const ua = ROBOTS_USER_AGENT.toLowerCase();
  const rules = groupRules.get(ua) ?? groupRules.get("*") ?? [];

  if (rules.length === 0) {
    return allowAllMatcher(sitemaps);
  }

  // Pre-compile patterns once.
  const compiled = rules.map((r) => ({
    allow: r.allow,
    length: r.pattern.length,
    re: patternToRegExp(r.pattern),
  }));

  function isAllowed(pathname: string): boolean {
    // robots matching is against the path (+ query). Ensure a leading slash.
    const target = pathname.startsWith("/") ? pathname : `/${pathname}`;

    let best: { allow: boolean; length: number } | null = null;
    for (const rule of compiled) {
      if (!rule.re.test(target)) continue;
      if (
        best === null ||
        rule.length > best.length ||
        // Tie on length → Allow wins over Disallow.
        (rule.length === best.length && rule.allow && !best.allow)
      ) {
        best = { allow: rule.allow, length: rule.length };
      }
    }
    // No matching rule → allowed.
    return best === null ? true : best.allow;
  }

  return { isAllowed, sitemaps };
}

/**
 * Fetch + parse `<origin>/robots.txt`. Best-effort: any network error, timeout,
 * or non-200 yields an allow-all matcher (discovery proceeds, the caller may
 * warn). `origin` should be a normalized origin like `https://example.com`.
 */
export async function fetchRobots(origin: string): Promise<RobotsMatcher> {
  const url = `${origin.replace(/\/$/, "")}/robots.txt`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROBOTS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": ROBOTS_USER_AGENT },
      redirect: "follow",
    });
    if (!res.ok) return allowAllMatcher();
    const text = await res.text();
    return parseRobots(text);
  } catch {
    return allowAllMatcher();
  } finally {
    clearTimeout(timer);
  }
}
