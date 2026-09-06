/**
 * Tests for the MCP text pipeline (ROADMAP Phase G).
 *
 * Small, and load-bearing for all four tools: everything page-derived that
 * reaches an agent's transcript goes through `safeText`. The cases below are the
 * two forgery routes — a control character that fakes a new line of output, and
 * a bidi override that makes a filename read backwards — plus the one property
 * that is easy to lose in a rewrite: a control character must not silently glue
 * two words together.
 */

import { describe, expect, it } from "vitest";

import { displaySafe, safeText } from "@/lib/text/displaySafe";

describe("displaySafe", () => {
  it("turns a control character into a space instead of deleting it", () => {
    // Deleting would yield "foobar" — a token the report never contained.
    expect(displaySafe("foo\u0000bar")).toBe("foo bar");
    expect(displaySafe("line one\nline two")).toBe("line one line two");
    expect(displaySafe("a\u001b[2Kb")).toBe("a [2Kb");
  });

  it("removes the invisible and bidi set outright", () => {
    // `…/gnp.exe` rendered as `…/exe.png` is the attack this closes.
    expect(displaySafe("photo\u202egnp.exe")).toBe("photognp.exe");
    expect(displaySafe("a\u200bb\u00adc")).toBe("abc");
    expect(displaySafe("\u2066spoof\u2069")).toBe("spoof");
  });

  it("collapses runs of whitespace and trims the ends", () => {
    expect(displaySafe("  a   b \t c  ")).toBe("a b c");
  });

  it("leaves ordinary text, including non-ASCII, untouched", () => {
    expect(displaySafe("Réduire le JavaScript inutilisé — 120 KiB")).toBe(
      "Réduire le JavaScript inutilisé — 120 KiB",
    );
  });
});

describe("safeText", () => {
  it("clamps with an ellipsis and never exceeds the budget", () => {
    const clamped = safeText("x".repeat(500), 40);
    expect(clamped).toHaveLength(40);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("clamps AFTER stripping, so invisible characters cannot eat the budget", () => {
    // 30 zero-width spaces then real text: strip first and all 12 characters
    // survive; clamp first and the caller would receive mostly nothing.
    expect(safeText(`${"\u200b".repeat(30)}visible text`, 20)).toBe("visible text");
  });

  it("returns an empty string for a value that was entirely invisible", () => {
    expect(safeText("\u200b\u200b\u0000", 20)).toBe("");
  });
});
