import { describe, expect, it } from "vitest";

import { apiError, badRequest, notFound, serverError } from "@/lib/api/errors";
import type { ApiErrorBody } from "@/lib/queue/types";

describe("apiError", () => {
  it("returns a Response with the given status and ApiErrorBody shape", async () => {
    const res = apiError(418, "teapot", "I'm a teapot.");
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(418);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as ApiErrorBody;
    expect(body).toEqual({ error: { message: "I'm a teapot.", code: "teapot" } });
  });

  it("includes issues when provided and non-empty", async () => {
    const issues = [{ path: "urls.0", message: "bad url" }];
    const res = apiError(400, "invalid_request", "nope", issues);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.issues).toEqual(issues);
  });

  it("omits the issues key when given an empty array", async () => {
    const res = apiError(400, "invalid_request", "nope", []);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error).not.toHaveProperty("issues");
  });

  it("omits the issues key when not provided", async () => {
    const res = apiError(404, "nope", "missing");
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error).not.toHaveProperty("issues");
  });
});

describe("status helpers", () => {
  it("badRequest yields status 400", async () => {
    const res = badRequest("invalid_json", "bad json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe("invalid_json");
  });

  it("badRequest forwards issues", async () => {
    const res = badRequest("invalid_request", "bad", [
      { path: "concurrency", message: "x" },
    ]);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.issues).toHaveLength(1);
  });

  it("notFound yields status 404", async () => {
    const res = notFound("batch_not_found", "missing");
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe("batch_not_found");
  });

  it("serverError yields status 500", async () => {
    const res = serverError("report_generation_failed", "boom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe("report_generation_failed");
  });
});
