import { describe, expect, it } from "vitest";

import {
  classifyAuditError,
  runtimeErrorMessage,
} from "@/lib/lighthouse/diagnose";

describe("runtimeErrorMessage", () => {
  it("returns null when there is no runtimeError", () => {
    expect(runtimeErrorMessage({})).toBeNull();
    expect(runtimeErrorMessage({ runtimeError: undefined })).toBeNull();
    expect(runtimeErrorMessage({ categories: {}, audits: {} })).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(runtimeErrorMessage(null)).toBeNull();
    expect(runtimeErrorMessage("nope")).toBeNull();
    expect(runtimeErrorMessage(undefined)).toBeNull();
  });

  it("returns null for a NO_ERROR code", () => {
    expect(
      runtimeErrorMessage({ runtimeError: { code: "NO_ERROR", message: "" } }),
    ).toBeNull();
  });

  it("maps known codes to friendly text", () => {
    const dns = runtimeErrorMessage({
      runtimeError: { code: "DNS_FAILURE", message: "DNS servers could not resolve" },
    });
    expect(dns).toMatch(/Lighthouse could not audit the page/);
    expect(dns).toMatch(/DNS lookup failed/);

    const noFcp = runtimeErrorMessage({
      runtimeError: { code: "NO_FCP", message: "The page did not paint any content." },
    });
    expect(noFcp).toMatch(/never rendered any content/);

    const failedDoc = runtimeErrorMessage({
      runtimeError: { code: "FAILED_DOCUMENT_REQUEST", message: "net::ERR" },
    });
    expect(failedDoc).toMatch(/server did not respond/);
  });

  it("falls back to the LHR's own message for an unknown code", () => {
    const msg = runtimeErrorMessage({
      runtimeError: { code: "SOMETHING_NEW", message: "A novel failure occurred." },
    });
    expect(msg).toBe("Lighthouse could not audit the page: A novel failure occurred.");
  });

  it("uses the code when an unknown code has no message", () => {
    const msg = runtimeErrorMessage({
      runtimeError: { code: "MYSTERY_CODE" },
    });
    expect(msg).toBe("Lighthouse could not audit the page: MYSTERY_CODE");
  });
});

describe("classifyAuditError", () => {
  const url = "https://example.com/";

  it("recognises Chrome launch failures (no installation)", () => {
    const msg = classifyAuditError(
      new Error("No Chrome installations found."),
      url,
    );
    expect(msg).toMatch(/Could not launch Chrome/);
    expect(msg).toMatch(/CHROME_PATH/);
    expect(msg).toContain(url);
  });

  it("recognises Chrome launch failures (cannot connect to debugging port)", () => {
    const msg = classifyAuditError(
      new Error("Unable to connect to Chrome"),
      url,
    );
    expect(msg).toMatch(/Could not launch Chrome/);
  });

  it("treats ECONNREFUSED against the local debugging port as a Chrome launch failure", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9222"), {
      code: "ECONNREFUSED",
    });
    const msg = classifyAuditError(err, url);
    expect(msg).toMatch(/Could not launch Chrome/);
  });

  it("recognises DNS / unreachable hosts (ENOTFOUND)", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND nope.invalid"), {
      code: "ENOTFOUND",
    });
    const msg = classifyAuditError(err, "https://nope.invalid/");
    expect(msg).toMatch(/Could not resolve/);
    expect(msg).toContain("https://nope.invalid/");
  });

  it("recognises a refused connection to a remote host", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443"), {
      code: "ECONNREFUSED",
    });
    const msg = classifyAuditError(err, url);
    expect(msg).toMatch(/refused the connection/);
  });

  it("recognises timeouts", () => {
    expect(classifyAuditError(new Error("Navigation timed out"), url)).toMatch(
      /took too long and timed out/,
    );
    const etimedout = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    expect(classifyAuditError(etimedout, url)).toMatch(/timed out/);
  });

  it("passes through a generic message and adds the url", () => {
    const msg = classifyAuditError(new Error("Something weird happened"), url);
    expect(msg).toBe(`Audit of ${url} failed: Something weird happened`);
  });

  it("does not duplicate the url when the original message already names it", () => {
    const msg = classifyAuditError(
      new Error(`Lighthouse returned no result for ${url} (formFactor=mobile).`),
      url,
    );
    expect(msg).toBe(`Lighthouse returned no result for ${url} (formFactor=mobile).`);
  });

  it("handles non-Error throwables", () => {
    expect(classifyAuditError("plain string failure", url)).toBe(
      `Audit of ${url} failed: plain string failure`,
    );
  });
});
