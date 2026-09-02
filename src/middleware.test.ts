/**
 * Unit tests for the local server's request gate (`src/middleware.ts`).
 *
 * The contract: a request is refused unless its Host header names this machine
 * (or an explicitly allowed host), and — once `npm start` has exported a
 * session token — unless it carries the session cookie or presents the token
 * once as `?token=`, which sets the cookie and strips the token from the URL.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { middleware } from "@/middleware";

const TOKEN = "test-session-token-0123456789abcdef0123456789";

let savedToken: string | undefined;
let savedHosts: string | undefined;

beforeEach(() => {
  savedToken = process.env.LH_SESSION_TOKEN;
  savedHosts = process.env.LH_ALLOWED_HOSTS;
  delete process.env.LH_SESSION_TOKEN;
  delete process.env.LH_ALLOWED_HOSTS;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.LH_SESSION_TOKEN;
  else process.env.LH_SESSION_TOKEN = savedToken;
  if (savedHosts === undefined) delete process.env.LH_ALLOWED_HOSTS;
  else process.env.LH_ALLOWED_HOSTS = savedHosts;
});

/** Build a request the way the server would see it. */
function request(
  path: string,
  options: { host?: string; headers?: Record<string, string>; method?: string } = {},
): NextRequest {
  const host = options.host ?? "127.0.0.1:3000";
  return new NextRequest(`http://${host}${path}`, {
    method: options.method ?? "GET",
    headers: { host, ...options.headers },
  });
}

/** `NextResponse.next()` marks pass-through with this header. */
function passedThrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

describe("Host allow-list", () => {
  it("passes loopback hosts with no token configured", () => {
    expect(passedThrough(middleware(request("/api/history")))).toBe(true);
    expect(passedThrough(middleware(request("/", { host: "localhost:3000" })))).toBe(true);
    expect(passedThrough(middleware(request("/", { host: "[::1]:3000" })))).toBe(true);
  });

  it("marks every response it produces so the start script can recognise it", () => {
    expect(middleware(request("/")).headers.get("x-lightaudit-gate")).toBe("1");
    expect(
      middleware(request("/", { host: "attacker.example" })).headers.get("x-lightaudit-gate"),
    ).toBe("1");
    process.env.LH_SESSION_TOKEN = TOKEN;
    expect(middleware(request("/api/history")).headers.get("x-lightaudit-gate")).toBe("1");
  });

  it("refuses a rebinding hostname before any other check", async () => {
    process.env.LH_SESSION_TOKEN = TOKEN;
    const response = middleware(
      request(`/api/settings/crawlforge?token=${TOKEN}`, {
        host: "attacker.example:3000",
        method: "PUT",
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden" });
  });

  it("allows a host the user listed in LH_ALLOWED_HOSTS", () => {
    process.env.LH_ALLOWED_HOSTS = "192.168.1.20";

    expect(passedThrough(middleware(request("/", { host: "192.168.1.20:3000" })))).toBe(true);
    expect(middleware(request("/", { host: "192.168.1.21:3000" })).status).toBe(403);
  });
});

describe("write origin", () => {
  const cookie = { cookie: `lh_session=${TOKEN}` };

  beforeEach(() => {
    process.env.LH_SESSION_TOKEN = TOKEN;
  });

  it("refuses a state-changing request from another loopback port, even with the cookie", () => {
    const viaFetchSite = middleware(
      request("/api/audits", {
        method: "POST",
        headers: { ...cookie, "sec-fetch-site": "same-site" },
      }),
    );
    expect(viaFetchSite.status).toBe(403);

    const viaOrigin = middleware(
      request("/api/audits", {
        method: "POST",
        headers: { ...cookie, origin: "http://127.0.0.1:5173" },
      }),
    );
    expect(viaOrigin.status).toBe(403);
  });

  it("accepts the app's own pages and non-browser clients", () => {
    expect(
      passedThrough(
        middleware(
          request("/api/audits", {
            method: "POST",
            headers: { ...cookie, "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:3000" },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      passedThrough(middleware(request("/api/audits", { method: "POST", headers: cookie }))),
    ).toBe(true);
  });

  it("applies even when no token is configured (a bare dev server)", () => {
    delete process.env.LH_SESSION_TOKEN;

    const response = middleware(
      request("/api/audits", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }),
    );

    expect(response.status).toBe(403);
  });
});

describe("session token", () => {
  beforeEach(() => {
    process.env.LH_SESSION_TOKEN = TOKEN;
  });

  it("always strips ?token= from a navigation, even when the cookie is already set", () => {
    const response = middleware(
      request(`/?token=${TOKEN}`, { headers: { cookie: `lh_session=${TOKEN}` } }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/");
  });

  it("strips a stale ?token= when the cookie is valid, without re-issuing the cookie", () => {
    const response = middleware(
      request("/?token=stale", { headers: { cookie: `lh_session=${TOKEN}` } }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("collapses a protocol-relative path so the redirect cannot leave this host", () => {
    const response = middleware(request(`//evil.example/?token=${TOKEN}`));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/evil.example/");
  });

  it("accepts the real cookie even when a planted duplicate comes first", () => {
    const response = middleware(
      request("/api/history", { headers: { cookie: `lh_session=junk; lh_session=${TOKEN}` } }),
    );

    expect(passedThrough(response)).toBe(true);
  });

  it("refuses a request with no cookie — JSON for API callers", async () => {
    const response = middleware(request("/api/history"));

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({ error: "Unauthorized" });
  });

  it("shows a static page to a browser navigation without the cookie", async () => {
    const response = middleware(
      request("/history", { headers: { accept: "text/html,application/xhtml+xml" } }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("npm start");
    // Nothing from the request is reflected into the page.
    expect(body).not.toContain("/history");
  });

  it("accepts the token once via ?token=, sets the cookie, and strips it from the URL", () => {
    const response = middleware(request(`/history?token=${TOKEN}&sort=date`));

    expect(response.status).toBe(307);
    // Built on the Host header the browser used, not a reconstructed hostname.
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/history?sort=date");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`lh_session=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=strict");
    expect(cookie).toContain("Max-Age=");
  });

  it("sets the cookie without redirecting for a non-navigation request", () => {
    const response = middleware(request(`/api/history?token=${TOKEN}`, { method: "POST" }));

    expect(passedThrough(response)).toBe(true);
    expect(response.headers.get("set-cookie")).toContain("lh_session=");
  });

  it("refuses a wrong token in the query", () => {
    expect(middleware(request("/?token=nope")).status).toBe(401);
    expect(middleware(request(`/?token=${TOKEN}x`)).status).toBe(401);
  });

  it("passes a request carrying the session cookie", () => {
    const response = middleware(
      request("/api/history", { headers: { cookie: `lh_session=${TOKEN}` } }),
    );

    expect(passedThrough(response)).toBe(true);
  });

  it("refuses a wrong cookie", () => {
    const response = middleware(
      request("/api/history", { headers: { cookie: "lh_session=wrong" } }),
    );

    expect(response.status).toBe(401);
  });
});
