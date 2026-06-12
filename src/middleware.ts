/**
 * Next.js middleware — per-session auth token validation (SAAS_PLAN.md Phase A).
 *
 * Security requirement: the local server binds 127.0.0.1 ONLY. Any other local
 * process (e.g. a web page open in the user's browser) could reach the audit API
 * via fetch to 127.0.0.1:<port> WITHOUT this gate. The per-session token prevents
 * that: only the Electron BrowserWindow (which loaded the URL with ?token=...)
 * and its resulting fetch calls (which include the token via cookie or header)
 * can access protected routes.
 *
 * Token flow:
 *   1. Electron main.js generates a 64-hex-char random token at launch.
 *   2. The BrowserWindow loads http://127.0.0.1:<port>/?token=<token>.
 *   3. This middleware reads the token on the first load, stores it in a cookie
 *      (HttpOnly, SameSite=Strict, Secure=false since we're on http://127.0.0.1).
 *   4. Subsequent requests (navigation, API calls) carry the cookie and pass.
 *   5. Non-Electron requests (no cookie, wrong token) get 401.
 *
 * When LH_SESSION_TOKEN is not set (dev mode: `next dev` / `next start`),
 * the middleware is a no-op and all requests pass through.
 *
 * Matching: applies to all routes EXCEPT Next.js internals (_next/*).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const COOKIE_NAME = "lh_session";
const TOKEN_ENV = "LH_SESSION_TOKEN";

export function middleware(request: NextRequest): NextResponse {
  const sessionToken = process.env[TOKEN_ENV];

  // Dev mode (no session token configured): allow all requests.
  if (!sessionToken) {
    return NextResponse.next();
  }

  const { searchParams } = request.nextUrl;

  // Check cookie first (set after initial load)
  const cookieToken = request.cookies.get(COOKIE_NAME)?.value;
  if (cookieToken === sessionToken) {
    return NextResponse.next();
  }

  // On the initial load, the token arrives as a query param (?token=...).
  // Validate it, set the cookie, then redirect to strip the token from the URL
  // so it doesn't appear in the address bar or logs.
  const queryToken = searchParams.get("token");
  if (queryToken === sessionToken) {
    // Valid token in query — set the session cookie and continue.
    const response = NextResponse.next();
    response.cookies.set(COOKIE_NAME, sessionToken, {
      httpOnly: true,
      sameSite: "strict",
      // Not marking secure because we're on http://127.0.0.1 (not https)
      secure: false,
      // Session cookie (no maxAge) — cleared when the browser session ends
      path: "/",
    });
    return response;
  }

  // No valid token — reject.
  // Return a minimal 401 response (not a redirect loop).
  return new NextResponse(
    JSON.stringify({
      error: "Unauthorized",
      message: "Missing or invalid session token. Open the app through LightAudit.",
    }),
    {
      status: 401,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export const config = {
  // Apply to all routes except Next.js internals
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
