import { describe, expect, it } from "vitest";

import {
  basicAuthHeaderValue,
  buildCredentialHeaders,
  credentialsFromEnv,
  ENV_CREDENTIAL_HOSTS,
  envCredentialsForUrl,
  extractAuditCredentials,
  hasUnscopedEnvCredentials,
  matchesCredentialHost,
  parseCredentialHosts,
  hasAuditCredentials,
  mergeAuditCredentials,
  parseBasicAuthEnv,
  parseCookiesEnv,
  parseExtraHeadersEnv,
  redactAuditOptions,
  REDACTED,
  scrubLhrCredentials,
  serializeCookies,
  stripAuditCredentials,
  type AuditCredentials,
} from "@/lib/lighthouse/credentials";
import { DEFAULT_OPTIONS, resolveAuditOptions } from "@/lib/lighthouse/options";

/** A credential set exercising all three mechanisms at once. */
const FULL: AuditCredentials = {
  extraHeaders: { "X-Preview-Token": "header-secret" },
  cookies: { session: "cookie-secret" },
  basicAuth: { username: "staging", password: "basic-secret" },
};

/** Every secret VALUE in {@link FULL}; nothing in the app may ever persist one. */
const SECRETS = ["header-secret", "cookie-secret", "basic-secret"];

describe("hasAuditCredentials", () => {
  it("is false for undefined, null and an empty object", () => {
    expect(hasAuditCredentials(undefined)).toBe(false);
    expect(hasAuditCredentials(null)).toBe(false);
    expect(hasAuditCredentials({})).toBe(false);
  });

  it("treats empty header/cookie maps as no credential", () => {
    expect(hasAuditCredentials({ extraHeaders: {}, cookies: {} })).toBe(false);
  });

  it("is true when any single mechanism is set", () => {
    expect(hasAuditCredentials({ extraHeaders: { A: "1" } })).toBe(true);
    expect(hasAuditCredentials({ cookies: { s: "1" } })).toBe(true);
    expect(
      hasAuditCredentials({ basicAuth: { username: "u", password: "p" } }),
    ).toBe(true);
  });
});

describe("extractAuditCredentials", () => {
  it("returns undefined when there is nothing to extract", () => {
    expect(extractAuditCredentials({ extraHeaders: {} })).toBeUndefined();
  });

  it("picks only the credential fields, deep-copied", () => {
    const options = { ...DEFAULT_OPTIONS, ...FULL };
    const extracted = extractAuditCredentials(options);
    expect(extracted).toEqual(FULL);
    expect(extracted).not.toHaveProperty("formFactor");
    // Deep copy: mutating the extract must not reach back into the source.
    extracted!.extraHeaders!["X-Preview-Token"] = "changed";
    expect(options.extraHeaders!["X-Preview-Token"]).toBe("header-secret");
  });
});

describe("stripAuditCredentials", () => {
  it("removes the fields entirely, keeping the rest of the options", () => {
    const stripped = stripAuditCredentials({ ...DEFAULT_OPTIONS, ...FULL });
    expect(stripped).toEqual(DEFAULT_OPTIONS);
    expect("extraHeaders" in stripped).toBe(false);
    expect("cookies" in stripped).toBe(false);
    expect("basicAuth" in stripped).toBe(false);
  });

  it("leaves credential-free options untouched", () => {
    expect(stripAuditCredentials({ ...DEFAULT_OPTIONS })).toEqual(DEFAULT_OPTIONS);
  });
});

describe("redactAuditOptions", () => {
  it("replaces every value while preserving names", () => {
    expect(redactAuditOptions({ ...DEFAULT_OPTIONS, ...FULL })).toEqual({
      ...DEFAULT_OPTIONS,
      extraHeaders: { "X-Preview-Token": REDACTED },
      cookies: { session: REDACTED },
      basicAuth: { username: REDACTED, password: REDACTED },
    });
  });

  it("leaks no secret through JSON serialisation", () => {
    const json = JSON.stringify(redactAuditOptions({ ...DEFAULT_OPTIONS, ...FULL }));
    for (const secret of SECRETS) expect(json).not.toContain(secret);
  });

  it("is idempotent, so defensive re-redaction never degrades the record", () => {
    const once = redactAuditOptions({ ...DEFAULT_OPTIONS, ...FULL });
    expect(redactAuditOptions(once)).toEqual(once);
  });

  it("does not mutate its input", () => {
    const options = { ...DEFAULT_OPTIONS, ...FULL };
    redactAuditOptions(options);
    expect(options.extraHeaders!["X-Preview-Token"]).toBe("header-secret");
    expect(options.basicAuth!.password).toBe("basic-secret");
  });

  it("passes credential-free options through unchanged", () => {
    expect(redactAuditOptions(DEFAULT_OPTIONS)).toEqual(DEFAULT_OPTIONS);
  });
});

describe("mergeAuditCredentials", () => {
  it("returns the other side when one is empty", () => {
    expect(mergeAuditCredentials(undefined, FULL)).toEqual(FULL);
    expect(mergeAuditCredentials(FULL, undefined)).toEqual(FULL);
    expect(mergeAuditCredentials(undefined, undefined)).toBeUndefined();
  });

  it("lets the override win per entry and keeps the base's other entries", () => {
    const merged = mergeAuditCredentials(
      {
        extraHeaders: { "X-A": "env-a", "X-B": "env-b" },
        cookies: { session: "env-session" },
        basicAuth: { username: "env", password: "env-pass" },
      },
      {
        extraHeaders: { "X-B": "batch-b" },
        basicAuth: { username: "batch", password: "batch-pass" },
      },
    );
    expect(merged).toEqual({
      extraHeaders: { "X-A": "env-a", "X-B": "batch-b" },
      cookies: { session: "env-session" },
      basicAuth: { username: "batch", password: "batch-pass" },
    });
  });
});

describe("buildCredentialHeaders", () => {
  it("returns undefined when there is nothing to send", () => {
    expect(buildCredentialHeaders(undefined)).toBeUndefined();
    expect(buildCredentialHeaders({ cookies: {} })).toBeUndefined();
  });

  it("folds all three mechanisms into one header map", () => {
    expect(buildCredentialHeaders(FULL)).toEqual({
      Authorization: `Basic ${btoa("staging:basic-secret")}`,
      Cookie: "session=cookie-secret",
      "X-Preview-Token": "header-secret",
    });
  });

  it("lets an explicit header override the basicAuth/cookie sugar", () => {
    expect(
      buildCredentialHeaders({
        basicAuth: { username: "u", password: "p" },
        cookies: { a: "1" },
        extraHeaders: { Authorization: "Bearer explicit", Cookie: "b=2" },
      }),
    ).toEqual({ Authorization: "Bearer explicit", Cookie: "b=2" });
  });

  it("encodes a non-ASCII basic-auth password as UTF-8 base64", () => {
    // `btoa` alone is latin1 and would throw on this; the header must match what
    // a browser sends, i.e. base64 of the UTF-8 bytes.
    const value = basicAuthHeaderValue({ username: "üser", password: "pässwörd" });
    const decoded = Buffer.from(value.replace("Basic ", ""), "base64").toString(
      "utf8",
    );
    expect(decoded).toBe("üser:pässwörd");
  });
});

describe("serializeCookies", () => {
  it("joins pairs with '; ' as a Cookie header does", () => {
    expect(serializeCookies({ a: "1", b: "2" })).toBe("a=1; b=2");
  });
});

describe("credentialsFromEnv", () => {
  it("returns undefined for an empty environment", () => {
    expect(credentialsFromEnv({})).toBeUndefined();
    expect(credentialsFromEnv({ LH_AUDIT_BASIC_AUTH: "   " })).toBeUndefined();
  });

  it("reads all three env vars", () => {
    expect(
      credentialsFromEnv({
        LH_AUDIT_BASIC_AUTH: "staging:basic-secret",
        LH_AUDIT_EXTRA_HEADERS: '{"X-Preview-Token":"header-secret"}',
        LH_AUDIT_COOKIES: "session=cookie-secret",
      }),
    ).toEqual(FULL);
  });

  it("splits the basic-auth pair on the FIRST colon only", () => {
    expect(parseBasicAuthEnv("user:pa:ss:word")).toEqual({
      username: "user",
      password: "pa:ss:word",
    });
  });

  it("ignores a basic-auth entry with no colon or no username", () => {
    expect(parseBasicAuthEnv("nocolon")).toBeUndefined();
    expect(parseBasicAuthEnv(":password")).toBeUndefined();
  });

  it("ignores malformed JSON rather than throwing", () => {
    expect(parseExtraHeadersEnv("not json")).toBeUndefined();
    expect(parseExtraHeadersEnv("[1,2]")).toBeUndefined();
    expect(parseCookiesEnv("{oops")).toBeUndefined();
  });

  it("drops header entries with an illegal name or an injected line break", () => {
    expect(
      parseExtraHeadersEnv(
        '{"Bad Name":"x","X-Good":"ok","X-Inject":"a\\r\\nSet-Cookie: b","X-Num":1}',
      ),
    ).toEqual({ "X-Good": "ok" });
  });

  it("accepts cookies as a DevTools-style Cookie string or as JSON", () => {
    expect(parseCookiesEnv("session=abc; csrf=def")).toEqual({
      session: "abc",
      csrf: "def",
    });
    expect(parseCookiesEnv('{"session":"abc"}')).toEqual({ session: "abc" });
  });

  it("keeps '=' inside a cookie value when parsing the header string", () => {
    expect(parseCookiesEnv("token=YWJjPT0=")).toEqual({ token: "YWJjPT0=" });
  });
});

describe("scrubLhrCredentials", () => {
  it("nulls configSettings.extraHeaders, Lighthouse's own default", () => {
    const lhr = {
      configSettings: { formFactor: "mobile", extraHeaders: { Authorization: "s" } },
    };
    scrubLhrCredentials(lhr);
    expect(lhr.configSettings.extraHeaders).toBeNull();
    // Everything else about the settings survives.
    expect(lhr.configSettings.formFactor).toBe("mobile");
  });

  it("is a no-op on a report that never carried headers", () => {
    const lhr = { configSettings: { formFactor: "mobile" } };
    scrubLhrCredentials(lhr);
    expect(lhr).toEqual({ configSettings: { formFactor: "mobile" } });
  });

  it("tolerates a missing/!object report without throwing", () => {
    expect(() => scrubLhrCredentials(undefined)).not.toThrow();
    expect(() => scrubLhrCredentials(null)).not.toThrow();
    expect(() => scrubLhrCredentials("nope")).not.toThrow();
    expect(() => scrubLhrCredentials({})).not.toThrow();
  });
});

describe("auditOptionsSchema credential validation", () => {
  it("accepts and preserves all three mechanisms", () => {
    expect(resolveAuditOptions(FULL)).toEqual({ ...DEFAULT_OPTIONS, ...FULL });
  });

  it("omits credentials entirely by default", () => {
    expect(DEFAULT_OPTIONS.extraHeaders).toBeUndefined();
    expect(DEFAULT_OPTIONS.cookies).toBeUndefined();
    expect(DEFAULT_OPTIONS.basicAuth).toBeUndefined();
  });

  it("normalises an empty map to undefined", () => {
    const options = resolveAuditOptions({ extraHeaders: {}, cookies: {} });
    expect(options.extraHeaders).toBeUndefined();
    expect(options.cookies).toBeUndefined();
    expect(hasAuditCredentials(options)).toBe(false);
  });

  it("rejects a header value carrying a CRLF injection", () => {
    expect(() =>
      resolveAuditOptions({ extraHeaders: { "X-A": "a\r\nSet-Cookie: b=c" } }),
    ).toThrow(/line breaks/);
  });

  it("rejects an illegal header name", () => {
    expect(() =>
      resolveAuditOptions({ extraHeaders: { "Bad Name": "v" } }),
    ).toThrow(/Header name/);
  });

  it("rejects a cookie value containing ';'", () => {
    expect(() => resolveAuditOptions({ cookies: { a: "1; b=2" } })).toThrow(/';'/);
  });

  it("rejects an empty basic-auth username", () => {
    expect(() =>
      resolveAuditOptions({ basicAuth: { username: "", password: "p" } }),
    ).toThrow(/username/);
  });

  it("caps the number of entries", () => {
    const many = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`X-H${i}`, "v"]),
    );
    expect(() => resolveAuditOptions({ extraHeaders: many })).toThrow(
      /at most 32/,
    );
  });
});

describe("env credential host scoping", () => {
  const ENV = {
    [ENV_CREDENTIAL_HOSTS]: "staging.example.com, *.preview.example.com, box.local:8443",
    LH_AUDIT_BASIC_AUTH: "staging:basic-secret",
  };

  it("parses the host list, trimming and lower-casing", () => {
    expect(parseCredentialHosts(" A.com , B.COM ")).toEqual(["a.com", "b.com"]);
  });

  it("treats a missing or blank list as NO host, never as every host", () => {
    expect(parseCredentialHosts(undefined)).toEqual([]);
    expect(parseCredentialHosts("  ")).toEqual([]);
    expect(matchesCredentialHost("https://anything.example.com/", [])).toBe(false);
  });

  it("matches an exact host, ignoring scheme, port-less-ness, path and www.", () => {
    const hosts = parseCredentialHosts(ENV[ENV_CREDENTIAL_HOSTS]);
    expect(matchesCredentialHost("https://staging.example.com/a/b", hosts)).toBe(true);
    expect(matchesCredentialHost("http://staging.example.com/", hosts)).toBe(true);
    expect(matchesCredentialHost("https://www.staging.example.com/", hosts)).toBe(true);
  });

  it("does not match an unrelated host — the competitor-batch case", () => {
    const hosts = parseCredentialHosts(ENV[ENV_CREDENTIAL_HOSTS]);
    expect(matchesCredentialHost("https://competitor.com/", hosts)).toBe(false);
    expect(matchesCredentialHost("https://example.com/", hosts)).toBe(false);
  });

  it("matches subdomains for a '*.' entry but never the apex or a lookalike", () => {
    const hosts = parseCredentialHosts(ENV[ENV_CREDENTIAL_HOSTS]);
    expect(matchesCredentialHost("https://pr-42.preview.example.com/", hosts)).toBe(true);
    // The apex itself is NOT covered by `*.`
    expect(matchesCredentialHost("https://preview.example.com/", hosts)).toBe(false);
    // The suffix must land on a dot boundary, so neither of these can match.
    expect(matchesCredentialHost("https://notpreview.example.com/", hosts)).toBe(false);
    expect(
      matchesCredentialHost("https://preview.example.com.attacker.net/", hosts),
    ).toBe(false);
  });

  it("honours a port when the entry names one", () => {
    const hosts = parseCredentialHosts(ENV[ENV_CREDENTIAL_HOSTS]);
    expect(matchesCredentialHost("https://box.local:8443/", hosts)).toBe(true);
    expect(matchesCredentialHost("https://box.local:9000/", hosts)).toBe(false);
    expect(matchesCredentialHost("https://box.local/", hosts)).toBe(false);
  });

  it("returns the credential only for an allow-listed URL", () => {
    expect(envCredentialsForUrl(ENV, "https://staging.example.com/")).toEqual({
      basicAuth: { username: "staging", password: "basic-secret" },
    });
    expect(envCredentialsForUrl(ENV, "https://competitor.com/")).toBeUndefined();
  });

  it("applies NOTHING when the credential is configured with no host list", () => {
    // The regression this gate exists for: an ambient `.env` credential must not
    // ride along on an audit of some unrelated site.
    const unscoped = { LH_AUDIT_BASIC_AUTH: "staging:basic-secret" };
    expect(envCredentialsForUrl(unscoped, "https://staging.example.com/")).toBeUndefined();
    expect(hasUnscopedEnvCredentials(unscoped)).toBe(true);
  });

  it("does not report an unscoped credential when there is no credential", () => {
    expect(hasUnscopedEnvCredentials({})).toBe(false);
    expect(hasUnscopedEnvCredentials(ENV)).toBe(false);
  });

  it("ignores an unparseable URL rather than defaulting to allowed", () => {
    expect(matchesCredentialHost("not a url", ["staging.example.com"])).toBe(false);
  });
});

describe("allow-list entry parsing (security-review follow-ups)", () => {
  const matches = (entry: string, url: string): boolean =>
    matchesCredentialHost(url, parseCredentialHosts(entry));

  it("matches an entry that names a DEFAULT port", () => {
    // `URL.port` is "" for 443/80, so without an effective-port comparison this
    // reasonable-looking entry would fail closed with an unexplained 401.
    expect(matches("staging.example.com:443", "https://staging.example.com/")).toBe(true);
    expect(matches("staging.example.com:80", "http://staging.example.com/")).toBe(true);
    expect(matches("staging.example.com:443", "http://staging.example.com/")).toBe(false);
  });

  it("tolerates a pasted full URL, which is what people copy from a browser", () => {
    expect(matches("https://staging.example.com/", "https://staging.example.com/x")).toBe(true);
    expect(matches("https://box.local:8443", "https://box.local:8443/x")).toBe(true);
    expect(matches("https://staging.example.com/", "https://other.example.com/")).toBe(false);
  });

  it("requires brackets for an IPv6 literal, and matches when bracketed", () => {
    expect(matches("[::1]", "http://[::1]:3000/")).toBe(true);
    expect(matches("[::1]:3000", "http://[::1]:3000/")).toBe(true);
    expect(matches("[::1]:3000", "http://[::1]:9999/")).toBe(false);
    // Unbracketed would mis-split at the last colon; it must fail closed, not
    // become host ":" port "1".
    expect(matches("::1", "http://[::1]:3000/")).toBe(false);
  });

  it("refuses a wildcard broad enough to undo the allow-list", () => {
    // `*.com` is a plausible typo that would otherwise restore the exact blast
    // radius the allow-list exists to remove.
    expect(matches("*.com", "https://anything.com/")).toBe(false);
    expect(matches("*.co.uk", "https://site.co.uk/")).toBe(true); // two labels: allowed
    expect(matches("*", "https://anything.com/")).toBe(false);
    expect(matches("*.", "https://anything.com/")).toBe(false);
  });

  it("ignores a malformed entry without disabling the rest of the list", () => {
    const hosts = parseCredentialHosts("*.com, staging.example.com");
    expect(matchesCredentialHost("https://anything.com/", hosts)).toBe(false);
    expect(matchesCredentialHost("https://staging.example.com/", hosts)).toBe(true);
  });
});

describe("header maps do not inherit Object.prototype", () => {
  // Built via JSON.parse, which is both how it would really arrive (an API
  // body) and the only way to get `__proto__` as an OWN property — an object
  // literal `{__proto__: v}` sets the prototype instead.
  const protoHeaders = (value: string): Record<string, string> =>
    JSON.parse(`{"__proto__":${JSON.stringify(value)}}`) as Record<string, string>;

  it("keeps a header literally named __proto__ instead of dropping it", () => {
    // `__proto__` passes the RFC 7230 token grammar, so it can be typed. On a
    // normal object the assignment hits the prototype setter and vanishes.
    const headers = buildCredentialHeaders({ extraHeaders: protoHeaders("v") });
    expect(Object.keys(headers ?? {})).toContain("__proto__");
    expect(Object.getOwnPropertyDescriptor(headers, "__proto__")?.value).toBe("v");
  });

  it("redacts such a header rather than losing it", () => {
    const redacted = redactAuditOptions({ extraHeaders: protoHeaders("secret") });
    expect(
      Object.getOwnPropertyDescriptor(redacted.extraHeaders, "__proto__")?.value,
    ).toBe(REDACTED);
    expect(JSON.stringify(redacted)).not.toContain("secret");
  });
});
