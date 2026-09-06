import type { NextConfig } from "next";

import { CLIENT_REPORT_CSP, HTML_REPORT_CSP } from "./src/lib/http/reportCsp";

const nextConfig: NextConfig = {
  // Lighthouse, chrome-launcher and better-sqlite3 are native / ESM-heavy packages
  // that must NOT be bundled by Next — they run in the Node runtime only.
  // See PRD §5 ("Critical Next.js config").
  //
  // @anthropic-ai/claude-agent-sdk powers the AI score-analysis feature: it spawns
  // the Claude Code subprocess and ships a large bundled `.mjs`, so — like
  // lighthouse — it must stay external (never bundled) and run server-side only.
  serverExternalPackages: [
    "lighthouse",
    "chrome-launcher",
    "better-sqlite3",
    "@anthropic-ai/claude-agent-sdk",
  ],

  /**
   * Baseline response headers for every route.
   *
   * The app binds loopback and gates every request (`src/proxy.ts`), but the
   * pages it serves talk about — and link out to — sites the user audits, so:
   *  - `Referrer-Policy: no-referrer` stops the local URL (and anything in it)
   *    being announced to a citation link or a Lighthouse-viewer tab;
   *  - `X-Frame-Options: DENY` keeps another page in the browser from framing
   *    the app to read it — cookies ignore ports, so "another page" includes
   *    anything else on loopback;
   *  - `nosniff` keeps a JSON report from being re-interpreted as HTML.
   *
   * The CSP here deliberately says nothing about scripts. A `script-src` for an
   * App Router app needs per-request nonces threaded through the proxy, and a
   * half-right one breaks rendering while protecting nothing — React already
   * escapes everything this app renders. What it does cover are the directives
   * that need no nonce and cannot break a working page: no plugins, no
   * `<base>` rewriting the meaning of every relative URL, no form posting
   * anywhere but here, and no framing.
   *
   * The Lighthouse HTML report needs a far stricter CSP than any of this (see
   * `app/api/reports/[runId]/route.ts`), and a header set HERE overrides the one
   * a route put on its own response — so the CSP rule below deliberately does
   * not match that path, leaving the route's policy the only one in play. The
   * other three apply everywhere, that route included.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
      {
        // LAST on purpose: where two rules set the same header, the last match
        // wins — so this is what overrides the baseline CSP above for the
        // report. It lives here rather than only on the route because a config
        // header overrides the one a route sets on its own response. Verified
        // against a running server, not assumed.
        //
        source: "/api/reports/:path*",
        headers: [{ key: "Content-Security-Policy", value: HTML_REPORT_CSP }],
      },
      {
        // The client-ready report export (ROADMAP Phase H) needs the same
        // treatment for the same reason: it too answers with a whole HTML
        // document built from an audited page's data. Kept as its own rule
        // rather than folded into the pattern above — a combined matcher would
        // be a regex alternation whose zero-segment behaviour has to be
        // re-verified, and there is nothing to gain from being clever about two
        // literal prefixes.
        //
        // This is the third layer rather than the first: the response is served
        // `Content-Disposition: attachment`, and the document carries its own
        // `<meta>` CSP granting no `script-src` at all. But the baseline policy
        // above says nothing about scripts, and this is one of only two paths on
        // the origin where that silence could matter.
        //
        // A DIFFERENT constant from the rule above, deliberately: the Lighthouse
        // report is interactive and needs `script-src 'unsafe-inline'`, while the
        // client report ships no script whatsoever. Reusing the looser policy
        // here would grant a capability this document never uses.
        source: "/api/export/:path*",
        headers: [{ key: "Content-Security-Policy", value: CLIENT_REPORT_CSP }],
      },
    ];
  },

  // The scheduled-audits page moved from /archive to /schedule (2026-09-03) so
  // the URL matches its nav label; keep the old address working for bookmarks.
  async redirects() {
    return [
      { source: "/archive", destination: "/schedule", permanent: true },
      { source: "/archive/:path*", destination: "/schedule/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
