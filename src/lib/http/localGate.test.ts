/**
 * Unit tests for the local gate's pure helpers: which `Host` headers the server
 * answers to, and the constant-time token comparison.
 */

import { describe, expect, it } from "vitest";

import {
  hostnameOf,
  isAllowedHost,
  isLoopbackHostname,
  isTrustedWrite,
  parseAllowedHosts,
  safeEqual,
} from "@/lib/http/localGate";

/** A header reader over a plain object, case-insensitive like Headers. */
function headers(values: Record<string, string>) {
  const lower = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

describe("isTrustedWrite", () => {
  it("never blocks safe methods", () => {
    expect(isTrustedWrite("GET", headers({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isTrustedWrite("HEAD", headers({ origin: "http://evil.example" }))).toBe(true);
    expect(isTrustedWrite("OPTIONS", headers({ origin: "null" }))).toBe(true);
  });

  it("trusts a browser that says same-origin or none", () => {
    expect(isTrustedWrite("POST", headers({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isTrustedWrite("PUT", headers({ "Sec-Fetch-Site": "None" }))).toBe(true);
  });

  it("refuses same-site (another loopback port) and cross-site writes", () => {
    expect(isTrustedWrite("POST", headers({ "sec-fetch-site": "same-site" }))).toBe(false);
    expect(isTrustedWrite("DELETE", headers({ "sec-fetch-site": "cross-site" }))).toBe(false);
  });

  it("falls back to Origin vs Host, port included", () => {
    const host = "127.0.0.1:3000";
    expect(isTrustedWrite("POST", headers({ host, origin: "http://127.0.0.1:3000" }))).toBe(true);
    expect(isTrustedWrite("POST", headers({ host, origin: "http://127.0.0.1:5173" }))).toBe(false);
    expect(isTrustedWrite("POST", headers({ host, origin: "http://evil.example" }))).toBe(false);
    expect(isTrustedWrite("POST", headers({ host, origin: "null" }))).toBe(false);
    expect(isTrustedWrite("POST", headers({ host, origin: "not a url" }))).toBe(false);
  });

  it("refuses a write that declares no origin at all", () => {
    // Fail closed: this check is the only thing between the app and a page on
    // another loopback port (SameSite=Strict ignores ports), and a client that
    // sends neither header is precisely the one that would slip past it. A
    // scripted client declares `Origin` (see the case above) like any browser.
    expect(isTrustedWrite("POST", headers({ host: "127.0.0.1:3000" }))).toBe(false);
    expect(isTrustedWrite("DELETE", headers({ host: "127.0.0.1:3000" }))).toBe(false);
    // Safe methods are unaffected — they change nothing.
    expect(isTrustedWrite("GET", headers({ host: "127.0.0.1:3000" }))).toBe(true);
  });
});

describe("hostnameOf", () => {
  it("strips a port and lower-cases", () => {
    expect(hostnameOf("Example.COM:3000")).toBe("example.com");
    expect(hostnameOf("127.0.0.1:3000")).toBe("127.0.0.1");
    expect(hostnameOf("localhost")).toBe("localhost");
  });

  it("handles IPv6 with and without brackets", () => {
    expect(hostnameOf("[::1]:3000")).toBe("::1");
    expect(hostnameOf("[::1]")).toBe("::1");
    expect(hostnameOf("::1")).toBe("::1");
    expect(hostnameOf("[::1")).toBeNull();
  });

  it("is null for missing or blank values", () => {
    expect(hostnameOf(null)).toBeNull();
    expect(hostnameOf(undefined)).toBeNull();
    expect(hostnameOf("   ")).toBeNull();
    expect(hostnameOf(":3000")).toBeNull();
  });
});

describe("hostnameOf rejects a malformed Host", () => {
  it("refuses a header carrying userinfo, a path, or a second host", () => {
    // `127.0.0.1:3000@evil.example` has ONE colon, so a naive split reports a
    // loopback hostname — while the same raw header used as a URL base resolves
    // to `http://evil.example`, which is how the gate's `?token=` strip redirect
    // could be aimed off-origin. Refuse the header instead.
    expect(hostnameOf("127.0.0.1:3000@evil.example")).toBeNull();
    expect(hostnameOf("[::1]:3000@evil.example")).toBeNull();
    expect(hostnameOf("127.0.0.1/../evil.example")).toBeNull();
    expect(hostnameOf("127.0.0.1 evil.example")).toBeNull();
    expect(hostnameOf("127.0.0.1\\evil.example")).toBeNull();
    // A bracketed host must match WHOLE. Stripping brackets by character would
    // accept these and report the loopback half.
    expect(hostnameOf("[::1]evil]")).toBeNull();
    expect(hostnameOf("[127.0.0.1]:80]")).toBeNull();
    expect(hostnameOf("localhost:80]")).toBeNull();
    expect(hostnameOf("[::1")).toBeNull();
    expect(hostnameOf("[]")).toBeNull();
    // ...and the well-formed ones still parse.
    expect(hostnameOf("127.0.0.1:3000")).toBe("127.0.0.1");
    expect(hostnameOf("[::1]:3000")).toBe("::1");
    expect(hostnameOf("[::1]")).toBe("::1");
    // RFC 6874 zone id, and the underscore Docker/Windows host names use.
    expect(hostnameOf("[fe80::1%25eth0]:3000")).toBe("fe80::1%25eth0");
    expect(hostnameOf("my_host:3000")).toBe("my_host");
  });

  it("refuses a malformed Host at the allow-list, before any route runs", () => {
    expect(isAllowedHost("127.0.0.1:3000@evil.example", undefined)).toBe(false);
  });
});

describe("isLoopbackHostname", () => {
  it("accepts the loopback family", () => {
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "app.localhost"]) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const host of ["example.com", "localhost.example.com", "128.0.0.1", "10.0.0.1"]) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });

  it("rejects 0.0.0.0, the wildcard bind that is not a name for this machine", () => {
    // Browsers only stopped treating it as a route to local servers in 2024;
    // the allow-list must not depend on that.
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
  });
});

describe("isAllowedHost", () => {
  it("answers to loopback without any configuration", () => {
    expect(isAllowedHost("127.0.0.1:3000", undefined)).toBe(true);
    expect(isAllowedHost("localhost:3000", undefined)).toBe(true);
    expect(isAllowedHost("[::1]:3000", undefined)).toBe(true);
  });

  it("refuses a rebinding attacker's hostname", () => {
    expect(isAllowedHost("attacker.example:3000", undefined)).toBe(false);
    expect(isAllowedHost("attacker.example", "")).toBe(false);
  });

  it("refuses a missing Host header", () => {
    expect(isAllowedHost(null, undefined)).toBe(false);
  });

  it("honours LH_ALLOWED_HOSTS for a deliberate LAN bind, ports tolerated", () => {
    const allowed = "192.168.1.20, mybox.lan:3000";
    expect(isAllowedHost("192.168.1.20:3000", allowed)).toBe(true);
    expect(isAllowedHost("MYBOX.LAN:4000", allowed)).toBe(true);
    expect(isAllowedHost("192.168.1.21:3000", allowed)).toBe(false);
  });

  it("parses the allow-list into hostnames", () => {
    expect([...parseAllowedHosts("a.lan:1, ,B.lan")]).toEqual(["a.lan", "b.lan"]);
    expect(parseAllowedHosts(undefined).size).toBe(0);
  });
});

describe("safeEqual", () => {
  it("is true only for identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("", "a")).toBe(false);
  });
});
