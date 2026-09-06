/**
 * Unit tests for `credential-draft.ts` — the Authentication disclosure's
 * rows ↔ `AuditCredentials` translation, its validation, and the names-only
 * readout helpers. Pure + synchronous; no React, no DOM, no network.
 *
 * The load-bearing case is the LAST one in "resolveCredentialDraft": a blank
 * form must produce no credential FIELDS at all. An absent field is the only
 * honest representation of "no credential" — `{ extraHeaders: {} }` would say
 * the user authenticated with nothing.
 */

import { describe, expect, it } from "vitest";

import {
  type CredentialDraft,
  type CredentialRow,
  describeCredentialMechanisms,
  emptyCredentialDraft,
  emptyCredentialRow,
  resolveCredentialDraft,
  summarizeCredentials,
} from "@/components/audit/credential-draft";
import {
  MAX_CREDENTIAL_ENTRIES,
  MAX_HEADER_VALUE_LENGTH,
  REDACTED,
} from "@/lib/lighthouse/credentials";

/** Build rows with predictable ids (`r0`, `r1`, …) from `[name, value]` pairs. */
function rows(...pairs: [string, string][]): CredentialRow[] {
  return pairs.map(([name, value], i) => ({ id: `r${i}`, name, value }));
}

/** A draft with the given overrides layered over a pristine, all-blank one. */
function draft(overrides: Partial<CredentialDraft> = {}): CredentialDraft {
  return {
    basicAuth: { username: "", password: "" },
    cookies: [],
    headers: [],
    ...overrides,
  };
}

describe("emptyCredentialDraft", () => {
  it("opens with one blank row per list and no basic auth", () => {
    const initial = emptyCredentialDraft();
    expect(initial.basicAuth).toEqual({ username: "", password: "" });
    expect(initial.cookies).toHaveLength(1);
    expect(initial.headers).toHaveLength(1);
    expect(initial.cookies[0]).toEqual(emptyCredentialRow("cookie-0"));
  });

  it("gives every row a distinct key", () => {
    const initial = emptyCredentialDraft();
    const ids = [...initial.cookies, ...initial.headers].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveCredentialDraft", () => {
  it("folds basic auth, cookies and headers into one credential block", () => {
    const resolution = resolveCredentialDraft(
      draft({
        basicAuth: { username: "staging", password: "hunter2" },
        cookies: rows(["session", "abc123"]),
        headers: rows(["X-Preview-Token", "tok"]),
      }),
    );
    expect(resolution.hasErrors).toBe(false);
    expect(resolution.credentials).toEqual({
      basicAuth: { username: "staging", password: "hunter2" },
      cookies: { session: "abc123" },
      extraHeaders: { "X-Preview-Token": "tok" },
    });
  });

  it("drops incomplete rows without complaining about them", () => {
    const resolution = resolveCredentialDraft(
      draft({
        headers: rows(["X-Token", "tok"], ["", ""], ["   ", "  "]),
      }),
    );
    expect(resolution.hasErrors).toBe(false);
    expect(resolution.credentials).toEqual({ extraHeaders: { "X-Token": "tok" } });
  });

  it("trims pasted whitespace off both halves of a row", () => {
    const resolution = resolveCredentialDraft(
      draft({ cookies: rows(["  session  ", "  abc123  "]) }),
    );
    expect(resolution.hasErrors).toBe(false);
    expect(resolution.credentials?.cookies).toEqual({ session: "abc123" });
  });

  it("keeps a header with a deliberately empty value", () => {
    const resolution = resolveCredentialDraft(
      draft({ headers: rows(["X-Empty", ""]) }),
    );
    expect(resolution.hasErrors).toBe(false);
    expect(resolution.credentials?.extraHeaders).toEqual({ "X-Empty": "" });
  });

  it("does NOT trim the basic-auth pair — a password's spaces are significant", () => {
    const resolution = resolveCredentialDraft(
      draft({ basicAuth: { username: "user", password: " pad " } }),
    );
    expect(resolution.credentials?.basicAuth).toEqual({
      username: "user",
      password: " pad ",
    });
  });

  it("rejects a name outside the RFC 7230 token grammar, on its own row", () => {
    const resolution = resolveCredentialDraft(
      draft({ headers: rows(["X-Good", "a"], ["X Bad:", "b"]) }),
    );
    expect(resolution.hasErrors).toBe(true);
    expect(resolution.errors.headers.r0).toBeUndefined();
    expect(resolution.errors.headers.r1).toEqual({
      field: "name",
      message: expect.stringMatching(/may only contain/) as unknown as string,
    });
    // The valid row still travels — one bad row does not void the rest.
    expect(resolution.credentials?.extraHeaders).toEqual({ "X-Good": "a" });
  });

  it("rejects a semicolon in a cookie value but allows it in a header value", () => {
    expect(
      resolveCredentialDraft(draft({ cookies: rows(["a", "x;y"]) })).errors
        .cookies.r0,
    ).toEqual({
      field: "value",
      message: expect.stringMatching(/';'/) as unknown as string,
    });
    expect(
      resolveCredentialDraft(draft({ headers: rows(["a", "x;y"]) })).errors
        .headers.r0,
    ).toBeUndefined();
  });

  it("rejects an over-long value", () => {
    const resolution = resolveCredentialDraft(
      draft({ headers: rows(["X-Big", "v".repeat(MAX_HEADER_VALUE_LENGTH + 1)]) }),
    );
    expect(resolution.errors.headers.r0?.field).toBe("value");
    expect(resolution.errors.headers.r0?.message).toContain(
      `at most ${MAX_HEADER_VALUE_LENGTH} characters`,
    );
  });

  it("flags header names that collide case-insensitively, on both rows", () => {
    const resolution = resolveCredentialDraft(
      draft({ headers: rows(["X-Token", "a"], ["x-token", "b"]) }),
    );
    expect(resolution.errors.headers.r0?.field).toBe("name");
    expect(resolution.errors.headers.r0?.message).toMatch(/Duplicate header name/);
    expect(resolution.errors.headers.r1?.message).toMatch(/Duplicate header name/);
  });

  it("treats cookie names as case-sensitive, so `id` and `ID` coexist", () => {
    const resolution = resolveCredentialDraft(
      draft({ cookies: rows(["id", "a"], ["ID", "b"]) }),
    );
    expect(resolution.hasErrors).toBe(false);
    expect(resolution.credentials?.cookies).toEqual({ id: "a", ID: "b" });
  });

  it("flags a lone password as a missing username", () => {
    const resolution = resolveCredentialDraft(
      draft({ basicAuth: { username: "", password: "hunter2" } }),
    );
    expect(resolution.errors.username).toMatch(/must not be empty/);
    expect(resolution.credentials?.basicAuth).toBeUndefined();
  });

  it("allows an empty basic-auth password against a real username", () => {
    const resolution = resolveCredentialDraft(
      draft({ basicAuth: { username: "user", password: "" } }),
    );
    expect(resolution.hasErrors).toBe(false);
    expect(resolution.credentials?.basicAuth).toEqual({
      username: "user",
      password: "",
    });
  });

  it("reports the entry cap at panel level, not against a row", () => {
    const pairs = Array.from(
      { length: MAX_CREDENTIAL_ENTRIES + 1 },
      (_, i) => [`X-H${i}`, "v"] as [string, string],
    );
    const resolution = resolveCredentialDraft(draft({ headers: rows(...pairs) }));
    expect(resolution.errors.headers).toEqual({});
    expect(resolution.errors.panel).toEqual([
      `Provide at most ${MAX_CREDENTIAL_ENTRIES} extra headers.`,
    ]);
    expect(resolution.hasErrors).toBe(true);
  });

  it("warns (without erroring) when an explicit header overrides the sugar", () => {
    const resolution = resolveCredentialDraft(
      draft({
        basicAuth: { username: "u", password: "p" },
        cookies: rows(["session", "s"]),
        headers: rows(["authorization", "Bearer x"], ["Cookie", "a=b"]),
      }),
    );
    expect(resolution.hasErrors).toBe(false);
    expect(resolution.warnings).toEqual([
      "An explicit Authorization header overrides the basic-auth pair.",
      "An explicit Cookie header overrides the cookie rows.",
    ]);
  });

  it("names the first problem for the submit gate's caption", () => {
    const resolution = resolveCredentialDraft(
      draft({ basicAuth: { username: "", password: "p" }, headers: rows(["!!", "v"]) }),
    );
    expect(resolution.firstError).toBe("Basic-auth username must not be empty.");
  });

  it("produces NO credential fields at all for a blank form", () => {
    const resolution = resolveCredentialDraft(emptyCredentialDraft());
    expect(resolution.hasErrors).toBe(false);
    expect(resolution.errors.panel).toEqual([]);
    expect(resolution.warnings).toEqual([]);
    // Not `{}`, not `{ extraHeaders: {} }` — absent.
    expect(resolution.credentials).toBeUndefined();
  });

  it("produces no credential fields for rows that are only whitespace", () => {
    const resolution = resolveCredentialDraft(
      draft({ cookies: rows(["  ", " "]), headers: rows(["", "   "]) }),
    );
    expect(resolution.credentials).toBeUndefined();
    expect(resolution.hasErrors).toBe(false);
  });
});

describe("describeCredentialMechanisms", () => {
  it("names each mechanism in the order the engine applies them", () => {
    expect(
      describeCredentialMechanisms({
        extraHeaders: { "X-Preview-Token": "tok" },
        cookies: { session: "abc" },
        basicAuth: { username: "u", password: "p" },
      }),
    ).toEqual(["basic auth", "Cookie: session", "X-Preview-Token"]);
  });

  it("reads identically from already-redacted options", () => {
    expect(
      describeCredentialMechanisms({
        cookies: { session: REDACTED },
        basicAuth: { username: REDACTED, password: REDACTED },
      }),
    ).toEqual(["basic auth", "Cookie: session"]);
  });

  it("is empty for no credentials", () => {
    expect(describeCredentialMechanisms(undefined)).toEqual([]);
    expect(describeCredentialMechanisms({})).toEqual([]);
  });
});

describe("summarizeCredentials", () => {
  it("reads None when there is nothing to send", () => {
    expect(summarizeCredentials(undefined)).toBe("None");
    expect(summarizeCredentials({})).toBe("None");
  });

  it("counts keys when there is no basic auth", () => {
    expect(summarizeCredentials({ cookies: { a: "1" } })).toBe("1 key");
    expect(
      summarizeCredentials({ cookies: { a: "1" }, extraHeaders: { b: "2" } }),
    ).toBe("2 keys");
  });

  it("leads with Basic and counts the rest", () => {
    const basicAuth = { username: "u", password: "p" };
    expect(summarizeCredentials({ basicAuth })).toBe("Basic");
    expect(summarizeCredentials({ basicAuth, cookies: { a: "1" } })).toBe(
      "Basic +1",
    );
  });
});
