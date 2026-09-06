/**
 * Unit tests for `credentialedFetch.ts` — the one place discovery decides
 * whether a request may carry the audit credential.
 *
 * The redirect chain is the interesting part: `redirect: "follow"` would leak a
 * custom credential header (e.g. `X-Preview-Token`) to a cross-site redirect
 * target, because the fetch spec only strips `Authorization`, `Cookie`, `Host`
 * and `Proxy-Authorization`. These tests pin the hand-walked chain that avoids
 * it — and pin that an uncredentialed run still makes the original request.
 *
 * Hermetic: the global `fetch` is stubbed; no real network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  credentialedFetch,
  MAX_CREDENTIAL_REDIRECTS,
} from "@/lib/crawl/credentialedFetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

const UA = { "user-agent": "LighthouseAuditBot" };
const CREDENTIAL = { Authorization: "Basic dGVzdA==", "X-Token": "token-value" };

/** A canned response: either a redirect (`to`) or a terminal 200. */
interface Canned {
  to?: string;
  status?: number;
  body?: string;
}

/** Stub `fetch` with a per-URL script, recording every call's init. */
function stubFetch(script: Record<string, Canned>) {
  const fetchMock = vi.fn<
    (input: string, init?: RequestInit) => Promise<Response>
  >(async (input) => {
    const canned = script[String(input)];
    if (!canned) return new Response("", { status: 404 });
    if (canned.to !== undefined) {
      return new Response("", {
        status: canned.status ?? 302,
        headers: { location: canned.to },
      });
    }
    return new Response(canned.body ?? "ok", { status: canned.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A fresh, never-aborted init for a request. */
function init() {
  return { signal: new AbortController().signal, headers: { ...UA } };
}

/** The URLs the stub was asked for, in order. */
function requestedUrls(fetchMock: ReturnType<typeof stubFetch>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

/** The headers the stub was asked to send, per call, in order. */
function sentHeaders(
  fetchMock: ReturnType<typeof stubFetch>,
): Record<string, string>[] {
  return fetchMock.mock.calls.map(
    (call) => (call[1]?.headers ?? {}) as Record<string, string>,
  );
}

describe("credentialedFetch — without a resolver", () => {
  it("makes exactly one `redirect: follow` request, headers untouched", async () => {
    const fetchMock = stubFetch({ "https://a.test/": {} });
    const res = await credentialedFetch("https://a.test/", init());
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = fetchMock.mock.calls[0][1];
    expect(sent?.headers).toEqual(UA);
    expect(sent?.redirect).toBe("follow");
    // No hand-walking: the runtime follows the chain, as it always has.
    expect(Object.keys(sent ?? {}).sort()).toEqual([
      "headers",
      "redirect",
      "signal",
    ]);
  });
});

describe("credentialedFetch — with a resolver", () => {
  it("attaches what the resolver allows and drives redirects manually", async () => {
    const fetchMock = stubFetch({ "https://a.test/": {} });
    await credentialedFetch("https://a.test/", init(), () => CREDENTIAL);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
    expect(sentHeaders(fetchMock)[0]).toEqual({ ...UA, ...CREDENTIAL });
  });

  it("re-asks the resolver at every hop, dropping the credential off-site", async () => {
    const fetchMock = stubFetch({
      "https://a.test/start": { to: "https://evil.test/landing" },
      "https://evil.test/landing": {},
    });

    const res = await credentialedFetch(
      "https://a.test/start",
      init(),
      (url) => (url.startsWith("https://a.test/") ? CREDENTIAL : undefined),
    );

    expect(res.status).toBe(200);
    expect(requestedUrls(fetchMock)).toEqual([
      "https://a.test/start",
      "https://evil.test/landing",
    ]);
    // The first hop is credentialed; the cross-site hop gets NOTHING — not even
    // the custom header the fetch spec would have forwarded for us.
    expect(sentHeaders(fetchMock)).toEqual([{ ...UA, ...CREDENTIAL }, UA]);
  });

  it("re-attaches the credential when a chain comes back on-site", async () => {
    const fetchMock = stubFetch({
      "https://a.test/out": { to: "https://cdn.test/hop" },
      "https://cdn.test/hop": { to: "https://a.test/back" },
      "https://a.test/back": {},
    });

    await credentialedFetch("https://a.test/out", init(), (url) =>
      url.startsWith("https://a.test/") ? CREDENTIAL : undefined,
    );

    expect(sentHeaders(fetchMock)).toEqual([
      { ...UA, ...CREDENTIAL },
      UA,
      { ...UA, ...CREDENTIAL },
    ]);
  });

  it("resolves a relative Location against the URL it was returned from", async () => {
    const fetchMock = stubFetch({
      "https://a.test/deep/page": { to: "../moved" },
      "https://a.test/moved": {},
    });
    await credentialedFetch("https://a.test/deep/page", init(), () => CREDENTIAL);
    expect(requestedUrls(fetchMock)).toEqual([
      "https://a.test/deep/page",
      "https://a.test/moved",
    ]);
  });

  it("follows every redirect status a browser would", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const fetchMock = stubFetch({
        "https://a.test/from": { to: "https://a.test/to", status },
        "https://a.test/to": {},
      });
      const res = await credentialedFetch(
        "https://a.test/from",
        init(),
        () => CREDENTIAL,
      );
      expect(res.status, `status ${status}`).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      vi.unstubAllGlobals();
    }
  });

  it("stops after MAX_CREDENTIAL_REDIRECTS and returns the last redirect", async () => {
    // An endless self-redirect: the cap is what makes a hostile host bounded.
    const fetchMock = stubFetch({
      "https://a.test/loop": { to: "https://a.test/loop" },
    });
    const res = await credentialedFetch(
      "https://a.test/loop",
      init(),
      () => CREDENTIAL,
    );
    expect(res.status).toBe(302);
    expect(res.ok).toBe(false); // → the caller's "could not fetch" warning
    expect(fetchMock).toHaveBeenCalledTimes(MAX_CREDENTIAL_REDIRECTS + 1);
  });

  it("returns a 3xx that carries no Location rather than chasing it", async () => {
    const fetchMock = stubFetch({ "https://a.test/": { status: 302 } });
    const res = await credentialedFetch("https://a.test/", init(), () => CREDENTIAL);
    expect(res.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a 3xx whose Location cannot be parsed", async () => {
    const fetchMock = stubFetch({
      "https://a.test/": { to: "http://[not-a-url" },
    });
    const res = await credentialedFetch("https://a.test/", init(), () => CREDENTIAL);
    expect(res.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the caller's headers when a credential collides, case-insensitively", async () => {
    const fetchMock = stubFetch({ "https://a.test/": {} });
    await credentialedFetch("https://a.test/", init(), () => ({
      "User-Agent": "Impostor/1.0",
      Authorization: "Basic dGVzdA==",
    }));
    // Exactly one user-agent, and it is ours — otherwise `Headers` would send
    // "LighthouseAuditBot, Impostor/1.0".
    expect(sentHeaders(fetchMock)[0]).toEqual({
      ...UA,
      Authorization: "Basic dGVzdA==",
    });
  });

  it("propagates a network error unchanged (callers turn it into a warning)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(
      credentialedFetch("https://a.test/", init(), () => CREDENTIAL),
    ).rejects.toThrow("network down");
  });
});
