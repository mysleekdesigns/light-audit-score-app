/**
 * Unit tests for the structured-output ladder: split the sentinel block, validate
 * it, and degrade honestly when a weaker model gets the JSON wrong.
 *
 * The behaviours that matter most here are the un-fun ones — a half-written
 * block must not crash, a sloppy entry must not lose the good ones, and an
 * ungrounded provider must never emit a citation it could not have fetched.
 */

import { describe, expect, it } from "vitest";

import {
  buildRepairPrompt,
  collectSources,
  parseFixes,
  splitDiagnosisAndFixes,
} from "@/lib/analysis/structured";
import { FIXES_CLOSE, FIXES_OPEN, type Fix } from "@/lib/analysis/types";

/** Wrap a fixes payload the way the prompt asks the model to. */
function block(json: string): string {
  return `Some diagnosis prose.\n\n${FIXES_OPEN}\n${json}\n${FIXES_CLOSE}`;
}

const GOOD_FIX = {
  title: "Defer offscreen images",
  why: "Cuts LCP by not blocking on images below the fold.",
  steps: ["Add loading=lazy", "Verify with Lighthouse"],
  priority: "high",
  citations: [{ url: "https://web.dev/lazy-loading", title: "Lazy loading" }],
};

describe("splitDiagnosisAndFixes", () => {
  it("splits prose from the sentinel block", () => {
    const { diagnosis, fixesJson } = splitDiagnosisAndFixes(
      block(JSON.stringify({ fixes: [GOOD_FIX] })),
    );

    expect(diagnosis).toBe("Some diagnosis prose.");
    expect(JSON.parse(fixesJson ?? "")).toEqual({ fixes: [GOOD_FIX] });
  });

  it("treats a response with no block as diagnosis-only", () => {
    expect(splitDiagnosisAndFixes("Just prose.")).toEqual({
      diagnosis: "Just prose.",
      fixesJson: null,
    });
  });

  it("tolerates a missing closing sentinel (a truncated stream)", () => {
    const { diagnosis, fixesJson } = splitDiagnosisAndFixes(
      `Prose.\n${FIXES_OPEN}\n{"fixes": []}`,
    );

    expect(diagnosis).toBe("Prose.");
    expect(fixesJson).toBe('{"fixes": []}');
  });
});

describe("parseFixes", () => {
  it("validates a well-formed block", () => {
    const { fixes, error } = parseFixes(JSON.stringify({ fixes: [GOOD_FIX] }));

    expect(error).toBeNull();
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ title: GOOD_FIX.title, priority: "high" });
  });

  it("strips markdown fences a model wrapped the JSON in", () => {
    const fenced = "```json\n" + JSON.stringify({ fixes: [GOOD_FIX] }) + "\n```";
    expect(parseFixes(fenced).fixes).toHaveLength(1);
  });

  it("ignores commentary a chatty model appended after the object", () => {
    const chatty = `${JSON.stringify({ fixes: [GOOD_FIX] })}\n\nHope that helps!`;
    expect(parseFixes(chatty).error).toBeNull();
  });

  it("coerces loose fields and defaults an unknown priority to medium", () => {
    const { fixes } = parseFixes(
      JSON.stringify({
        fixes: [{ title: "Do the thing", priority: "urgent", steps: ["a", 7, "b"] }],
      }),
    );

    expect(fixes[0]).toMatchObject({ priority: "medium", why: "", steps: ["a", "b"] });
  });

  it("drops a malformed entry without losing the good ones", () => {
    const { fixes, error } = parseFixes(
      JSON.stringify({ fixes: [{ why: "no title" }, GOOD_FIX, null] }),
    );

    expect(error).toBeNull();
    expect(fixes.map((f) => f.title)).toEqual([GOOD_FIX.title]);
  });

  it("reports each failure mode so the caller can repair or degrade", () => {
    expect(parseFixes(null).error).toBe("missing_block");
    expect(parseFixes("   ").error).toBe("missing_block");
    expect(parseFixes("{fixes: [}").error).toBe("invalid_json");
    expect(parseFixes(JSON.stringify({ recommendations: [] })).error).toBe(
      "invalid_shape",
    );
    // Entries were present but none survived validation — worth a repair pass.
    expect(parseFixes(JSON.stringify({ fixes: [{ why: "no title" }] })).error).toBe(
      "no_valid_fixes",
    );
  });

  it("treats an empty fixes array as a valid answer, not a parse failure", () => {
    // A category scoring 100 genuinely has nothing to fix; reporting that as
    // broken JSON would trigger a pointless repair call and an untrue warning.
    expect(parseFixes(JSON.stringify({ fixes: [] }))).toEqual({
      fixes: [],
      error: null,
    });
  });

  it("never throws on hostile input", () => {
    for (const input of ["]", "null", '"a string"', "[]", "{}", "0"]) {
      expect(() => parseFixes(input)).not.toThrow();
      expect(parseFixes(input).fixes).toEqual([]);
      expect(parseFixes(input).error).not.toBeNull();
    }
  });

  it("drops citations for an ungrounded provider", () => {
    // A model with no fetch tool can only invent a URL, so we refuse to carry one.
    const { fixes } = parseFixes(JSON.stringify({ fixes: [GOOD_FIX] }), {
      allowCitations: false,
    });

    expect(fixes[0].citations).toEqual([]);
  });

  it("drops citation entries missing a url", () => {
    const { fixes } = parseFixes(
      JSON.stringify({
        fixes: [{ ...GOOD_FIX, citations: [{ title: "no url" }, { url: "https://ok" }] }],
      }),
    );

    expect(fixes[0].citations).toEqual([{ url: "https://ok", title: undefined }]);
  });
});

describe("collectSources", () => {
  it("dedupes across fixes, preserving first-seen order", () => {
    const fixes: Fix[] = [
      { ...GOOD_FIX, priority: "high", citations: [{ url: "https://a" }] },
      {
        ...GOOD_FIX,
        priority: "low",
        citations: [{ url: "https://b" }, { url: "https://a" }],
      },
    ];

    expect(collectSources(fixes).map((s) => s.url)).toEqual(["https://a", "https://b"]);
  });

  it("is empty when nothing was cited", () => {
    expect(collectSources([{ ...GOOD_FIX, priority: "high", citations: [] }])).toEqual([]);
  });
});

describe("buildRepairPrompt", () => {
  it("hands the broken text back with the target shape", () => {
    const prompt = buildRepairPrompt('{"fixes": [}');

    expect(prompt).toContain('{"fixes": [}');
    expect(prompt).toContain('"priority": "high" | "medium" | "low"');
  });

  it("asks for empty citations on an ungrounded provider", () => {
    expect(buildRepairPrompt("broken", false)).toContain('"citations": []');
    expect(buildRepairPrompt("broken", true)).toContain('"url": "https://…"');
  });

  it("truncates a runaway block", () => {
    const prompt = buildRepairPrompt("x".repeat(50_000));
    expect(prompt.length).toBeLessThan(20_000);
  });
});
