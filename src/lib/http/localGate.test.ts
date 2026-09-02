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

  it("leaves non-browser clients (no Origin, no Sec-Fetch-Site) alone", () => {
    expect(isTrustedWrite("POST", headers({ host: "127.0.0.1:3000" }))).toBe(true);
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

describe("isLoopbackHostname", () => {
  it("accepts the loopback family", () => {
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "0.0.0.0", "app.localhost"]) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const host of ["example.com", "localhost.example.com", "128.0.0.1", "10.0.0.1"]) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
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
