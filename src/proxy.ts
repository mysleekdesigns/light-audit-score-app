/**
 * Next.js proxy (`src/proxy.ts`, Next 16's name for middleware) — the local server's request gate.
 *
 * The server binds 127.0.0.1, but "local" is not "private": any web page open
 * in the user's browser can fire requests at 127.0.0.1:<port>, a page whose
 * hostname is quietly re-pointed at 127.0.0.1 (DNS rebinding) becomes
 * same-origin with the app, and a page on ANOTHER loopback port shares the
 * app's cookies (cookies ignore ports). Three checks close that, in order:
 *
 *   1. **Host allow-list.** The `Host` header must name a loopback address
 *      (`127.0.0.1`, `localhost`, `*.localhost`, `[::1]`) or one listed in
 *      `LH_ALLOWED_HOSTS` (comma-separated, for a deliberate LAN bind). A
 *      rebinding attacker's page arrives with THEIR hostname → 403.
 *
 *   2. **Write origin.** A state-changing request from a browser must be
 *      same-origin by `Sec-Fetch-Site` / `Origin` — so a page on
 *      `127.0.0.1:5173` cannot POST an audit with the user's cookie → 403.
 *
 *   3. **Session token.** `npm start` (scripts/start.mjs) resolves a
 *      per-install token, exports it as `LH_SESSION_TOKEN`, and prints a
 *      `?token=` link. Opening the link sets an HttpOnly, SameSite=Strict cookie
 *      and redirects to the same URL without the token; every later request must
 *      carry the cookie or gets 401. A `?token=` in the URL is ALWAYS stripped by
 *      redirect, cookie or not, so it never lingers in the address bar.
 *
 * When `LH_SESSION_TOKEN` is not set — a bare `next dev`, or `next start` run
 * without the start script — the token check is skipped and only checks 1–2
 * apply. That is the developer's dev-server case, not what `npm start` produces.
 *
 * Every response the gate itself produces carries `X-LightAudit-Gate: 1`, which
 * the start script uses to make sure the port it is about to open a browser on
 * is really this server.
 *
 * Matching: applies to all routes EXCEPT Next.js internals (_next/*).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { isAllowedHost, isTrustedWrite, safeEqual } from "@/lib/http/localGate";

const COOKIE_NAME = "lh_session";
const TOKEN_ENV = "LH_SESSION_TOKEN";
const ALLOWED_HOSTS_ENV = "LH_ALLOWED_HOSTS";
const TOKEN_QUERY = "token";
/** Marker so a client (the start script) can tell this gate from a stranger on the port. */
const GATE_HEADER = "X-LightAudit-Gate";
/** The token is stable per install, so the cookie may outlive the browser session. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * What a browser sees when it lands here without the token — a static page
 * with no request data reflected into it. Points at the link `npm start`
 * printed instead of a bare JSON error.
 */
const LOCKED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LightAudit Score — open via your session link</title>
<style>
  html { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0d12; color: #d6dde6; font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 34rem; padding: 2.5rem; border: 1px solid #1f2933; border-radius: 12px; background: #0f141b; }
  h1 { margin: 0 0 .25rem; font-size: 1.05rem; letter-spacing: .02em; }
  .kicker { font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .2em; text-transform: uppercase; color: #6b7a8c; margin-bottom: 1.25rem; }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; background: #161d26; padding: .15em .4em; border-radius: 4px; color: #e6edf5; }
  p { margin: .75rem 0; color: #a9b4c1; }
</style>
</head>
<body>
<main>
  <div class="kicker">LightAudit Score · local session</div>
  <h1>Open the app through your session link</h1>
  <p>This server only answers requests that carry its per-install session cookie. Use the link printed in the terminal where you ran <code>npm start</code> — it looks like <code>http://127.0.0.1:3000/?token=…</code> and sets the cookie for you.</p>
  <p>If you set <code>LH_SESSION_TOKEN</code> yourself, append <code>?token=&lt;that value&gt;</code> to the URL once.</p>
</main>
</body>
</html>
`;

/** Stamp the gate marker (and no-store) on a response the gate produced. */
function stamped(response: NextResponse): NextResponse {
  response.headers.set(GATE_HEADER, "1");
  return response;
}

/** A JSON refusal — same body for every caller, nothing reflected. */
function refuse(status: 401 | 403, error: string, message: string): NextResponse {
  return stamped(
    NextResponse.json(
      { error, message },
      { status, headers: { "Cache-Control": "no-store" } },
    ),
  );
}

/** 403 for a Host header this server does not answer to. */
function forbiddenHost(): NextResponse {
  return refuse(
    403,
    "Forbidden",
    "Unexpected Host header. LightAudit only answers to loopback hostnames; set LH_ALLOWED_HOSTS to allow others.",
  );
}

/** 403 for a state-changing request from another origin (another port, another site). */
function forbiddenOrigin(): NextResponse {
  return refuse(
    403,
    "Forbidden",
    "Cross-origin request refused. LightAudit only accepts changes from its own pages.",
  );
}

/** 401 — HTML for a browser navigation, JSON for everything else. */
function unauthorized(request: NextRequest): NextResponse {
  const wantsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
  if (wantsHtml) {
    return stamped(
      new NextResponse(LOCKED_PAGE, {
        status: 401,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        },
      }),
    );
  }
  return refuse(
    401,
    "Unauthorized",
    "Missing or invalid session token. Open the link printed by `npm start`.",
  );
}

/**
 * The redirect that strips `?token=` from a navigation. Next needs an absolute
 * target; it is built on the Host header the browser used — which passed the
 * allow-list, so this can only point back at a loopback (or explicitly
 * allowed) host. A protocol-relative path (`//evil.example`) is collapsed so
 * it cannot become a foreign origin. `null` if the URL cannot be formed.
 */
function stripTokenRedirect(request: NextRequest): NextResponse | null {
  const clean = request.nextUrl.clone();
  clean.searchParams.delete(TOKEN_QUERY);
  const pathname = clean.pathname.replace(/^\/{2,}/, "/");
  try {
    const origin = `${clean.protocol}//${request.headers.get("host")}`;
    return NextResponse.redirect(new URL(`${pathname}${clean.search}`, origin));
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest): NextResponse {
  // 1. Host allow-list — before anything else, for every route.
  if (!isAllowedHost(request.headers.get("host"), process.env[ALLOWED_HOSTS_ENV])) {
    return forbiddenHost();
  }

  // 2. Writes must come from this origin (also protects a token-less dev server).
  if (!isTrustedWrite(request.method, request.headers)) {
    return forbiddenOrigin();
  }

  // 3. Session token.
  const sessionToken = process.env[TOKEN_ENV]?.trim();
  if (!sessionToken) {
    // No token configured (dev server): the checks above are the boundary.
    return stamped(NextResponse.next());
  }

  // All cookies of that name, so a planted duplicate can't shadow the real one.
  const cookieValid = request.cookies
    .getAll(COOKIE_NAME)
    .some((cookie) => safeEqual(cookie.value, sessionToken));

  // A `?token=` in the URL is handled first so it is ALWAYS stripped: with a
  // cookie already set, the auto-opened link would otherwise render with the
  // token sitting in the address bar, history, and any copied link.
  const queryToken = request.nextUrl.searchParams.get(TOKEN_QUERY);
  if (queryToken !== null) {
    const queryValid = safeEqual(queryToken, sessionToken);
    if (!queryValid && !cookieValid) return unauthorized(request);

    const isNavigation = request.method === "GET" || request.method === "HEAD";
    const response =
      (isNavigation ? stripTokenRedirect(request) : null) ?? NextResponse.next();
    if (queryValid) {
      response.cookies.set(COOKIE_NAME, sessionToken, {
        httpOnly: true,
        sameSite: "strict",
        // Plain http://127.0.0.1 — a Secure cookie would never be sent.
        secure: false,
        path: "/",
        maxAge: COOKIE_MAX_AGE_SECONDS,
      });
    }
    return stamped(response);
  }

  if (cookieValid) return stamped(NextResponse.next());

  return unauthorized(request);
}

export const config = {
  // Apply to all routes except Next.js internals
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
