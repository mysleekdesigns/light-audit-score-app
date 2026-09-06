/**
 * `sanitizeBranding` is the security boundary between "a value the user typed
 * or picked" and "a value printed into an HTML file that gets emailed to a
 * client", so it is tested exhaustively and it is tested WITHOUT SQLite: every
 * case here is a pure call, which is the whole reason the sanitiser was kept
 * free of the store.
 *
 * The logo cases carry most of the weight. The rule that a logo is a `data:`
 * image and nothing else is what keeps an exported report renderable offline
 * and stops it beaconing from the recipient's machine, and the rule that it is
 * never SVG is what keeps a script-bearing document out of a file people open
 * by double-clicking it.
 */

import { describe, expect, it } from "vitest";

import {
  BRANDING_LOGO_MAX_BYTES,
  BRANDING_SUBTITLE_MAX,
  BRANDING_TITLE_MAX,
  sanitizeBranding,
  sanitizeLogoDataUri,
} from "@/lib/settings/branding";
import { EMPTY_BRANDING } from "@/lib/export/report-model";

/** A short, canonically-padded base64 body — enough to be a valid payload. */
const TINY_BASE64 = "iVBORw0KGgo=";

/** A `data:` URI of `type` carrying {@link TINY_BASE64}. */
function dataUri(type: string): string {
  return `data:image/${type};base64,${TINY_BASE64}`;
}

/**
 * A base64 body whose DECODED size is just over `bytes`. Built from a repeated
 * character so the test says what it means without a fixture file: four base64
 * characters carry three bytes, so this rounds up to the next whole quad.
 */
function oversizedBase64(bytes: number): string {
  const quads = Math.ceil(bytes / 3) + 1;
  return "A".repeat(quads * 4);
}

describe("sanitizeLogoDataUri", () => {
  it("accepts every allow-listed raster type", () => {
    for (const type of ["png", "jpeg", "webp", "gif"]) {
      expect(sanitizeLogoDataUri(dataUri(type))).toBe(dataUri(type));
    }
  });

  it("keeps the base64 payload byte-for-byte while normalising the prefix", () => {
    // base64 is case-SENSITIVE: lower-casing the whole URI would corrupt the
    // image, so only the scheme + media type may be folded.
    expect(sanitizeLogoDataUri(`DATA:IMAGE/PNG;BASE64,${TINY_BASE64}`)).toBe(
      dataUri("png"),
    );
  });

  it("rejects SVG — a script-bearing document, not a picture", () => {
    expect(sanitizeLogoDataUri(dataUri("svg+xml"))).toBe("");
    expect(sanitizeLogoDataUri("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe("");
    expect(
      sanitizeLogoDataUri("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"),
    ).toBe("");
  });

  it("rejects every scheme that is not `data:`", () => {
    expect(sanitizeLogoDataUri("https://evil.test/logo.png")).toBe("");
    expect(sanitizeLogoDataUri("http://evil.test/logo.png")).toBe("");
    expect(sanitizeLogoDataUri("//evil.test/x.png")).toBe("");
    expect(sanitizeLogoDataUri("javascript:alert(1)")).toBe("");
    expect(sanitizeLogoDataUri("file:///etc/passwd")).toBe("");
    expect(sanitizeLogoDataUri("vbscript:msgbox(1)")).toBe("");
  });

  it("rejects a `data:` URI that is not an allow-listed image", () => {
    expect(sanitizeLogoDataUri(`data:text/html;base64,${TINY_BASE64}`)).toBe("");
    expect(sanitizeLogoDataUri(`data:image/bmp;base64,${TINY_BASE64}`)).toBe("");
    expect(sanitizeLogoDataUri("data:image/png,notbase64")).toBe("");
    // A charset parameter before `;base64` is not the shape we accept.
    expect(
      sanitizeLogoDataUri(`data:image/png;charset=utf-8;base64,${TINY_BASE64}`),
    ).toBe("");
  });

  it("is anchored — a good needle inside a bad URI does not rescue it", () => {
    expect(sanitizeLogoDataUri(`javascript:alert(1)//${dataUri("png")}`)).toBe("");
    expect(sanitizeLogoDataUri(`${dataUri("png")}" onload="alert(1)`)).toBe("");
  });

  it("rejects a malformed base64 body", () => {
    // Not a multiple of four, and unpadded.
    expect(sanitizeLogoDataUri("data:image/png;base64,iVBORw0KGgo")).toBe("");
    // Characters outside the base64 alphabet.
    expect(sanitizeLogoDataUri("data:image/png;base64,!!!!")).toBe("");
    // Padding in the middle rather than at the end.
    expect(sanitizeLogoDataUri("data:image/png;base64,iVBO=w0KGgo=")).toBe("");
    // The URL-safe alphabet is a different encoding, not a lenient one.
    expect(sanitizeLogoDataUri("data:image/png;base64,iVBO-w0K_goA")).toBe("");
    // Whitespace inside the payload: never emitted by FileReader.
    expect(sanitizeLogoDataUri("data:image/png;base64,iVBO Rw0K Ggo=")).toBe("");
    // An empty payload is not a logo.
    expect(sanitizeLogoDataUri("data:image/png;base64,")).toBe("");
  });

  it("rejects a payload over the byte cap", () => {
    const tooBig = `data:image/png;base64,${oversizedBase64(BRANDING_LOGO_MAX_BYTES)}`;
    expect(sanitizeLogoDataUri(tooBig)).toBe("");
  });

  it("rejects a payload far over the cap without parsing it", () => {
    // The cheap length gate, exercised: valid in shape, absurd in size.
    const enormous = `data:image/png;base64,${"A".repeat(4_000_000)}`;
    expect(sanitizeLogoDataUri(enormous)).toBe("");
  });

  it("accepts a payload right at the byte cap", () => {
    const quads = Math.ceil(BRANDING_LOGO_MAX_BYTES / 3);
    const body = "A".repeat(quads * 4 - 2) + "==";
    const atCap = `data:image/png;base64,${body}`;
    expect(sanitizeLogoDataUri(atCap)).toBe(atCap);
  });

  it("returns `\"\"` for anything that is not a string", () => {
    expect(sanitizeLogoDataUri(undefined)).toBe("");
    expect(sanitizeLogoDataUri(null)).toBe("");
    expect(sanitizeLogoDataUri(42)).toBe("");
    expect(sanitizeLogoDataUri({ logoDataUri: dataUri("png") })).toBe("");
    expect(sanitizeLogoDataUri([dataUri("png")])).toBe("");
    expect(sanitizeLogoDataUri("   ")).toBe("");
  });
});

describe("sanitizeBranding", () => {
  it("keeps a fully-valid record intact", () => {
    expect(
      sanitizeBranding({
        title: "Northwind Audits",
        subtitle: "Quarterly performance review",
        logoDataUri: dataUri("png"),
        showDate: false,
      }),
    ).toEqual({
      title: "Northwind Audits",
      subtitle: "Quarterly performance review",
      logoDataUri: dataUri("png"),
      showDate: false,
    });
  });

  it("flattens newlines, tabs and control characters into one line", () => {
    const flattened = sanitizeBranding({
      title: "Northwind\nAudits\tLtd",
      subtitle: "Line one\r\nLine two\u0000end",
    });
    expect(flattened.title).toBe("Northwind Audits Ltd");
    // Both lines survive as one line: the break becomes a space rather than
    // vanishing, so no two words are silently welded into a third.
    expect(flattened.subtitle).toBe("Line one Line two end");
  });

  it("strips invisible and bidi characters", () => {
    // Written as escapes on purpose, the same discipline `displaySafe.ts`
    // keeps: literally, these are invisible in a diff, and a formatter that
    // ate one would weaken the test with nothing to see.
    const result = sanitizeBranding({
      title: "Northwind\u202egnp.exe\u200b Ltd",
    });
    expect(result.title).toBe("Northwindgnp.exe Ltd");
    expect(result.title).not.toMatch(/[\u200b\u202e]/);
  });

  it("caps over-length text at the documented limits", () => {
    const result = sanitizeBranding({
      title: "N".repeat(500),
      subtitle: "S".repeat(500),
    });
    expect(result.title).toHaveLength(BRANDING_TITLE_MAX);
    expect(result.subtitle).toHaveLength(BRANDING_SUBTITLE_MAX);
    // Truncation is visible rather than silent.
    expect(result.title.endsWith("…")).toBe(true);
    expect(result.subtitle.endsWith("…")).toBe(true);
  });

  it("prints the date unless it is explicitly switched off", () => {
    expect(sanitizeBranding({ showDate: false }).showDate).toBe(false);
    expect(sanitizeBranding({ showDate: true }).showDate).toBe(true);
    // Anything that is not the boolean `false` keeps the default.
    expect(sanitizeBranding({ showDate: "false" }).showDate).toBe(true);
    expect(sanitizeBranding({ showDate: 0 }).showDate).toBe(true);
    expect(sanitizeBranding({}).showDate).toBe(EMPTY_BRANDING.showDate);
  });

  it("yields EMPTY_BRANDING for non-records rather than throwing", () => {
    for (const input of [null, undefined, [], 42, "branding", true, {}]) {
      expect(sanitizeBranding(input)).toEqual(EMPTY_BRANDING);
    }
  });

  it("ignores non-string text fields instead of stringifying them", () => {
    expect(sanitizeBranding({ title: 42, subtitle: { toString: () => "x" } })).toEqual(
      EMPTY_BRANDING,
    );
  });

  it("does not let one bad field discard the good ones", () => {
    // A rejected SVG must not cost the user the name they typed.
    const result = sanitizeBranding({
      title: "Northwind Audits",
      subtitle: "Quarterly performance review",
      logoDataUri: dataUri("svg+xml"),
      showDate: false,
    });
    expect(result).toEqual({
      title: "Northwind Audits",
      subtitle: "Quarterly performance review",
      logoDataUri: "",
      showDate: false,
    });
  });

  it("returns only the four contract fields, never a passed-through extra", () => {
    const result = sanitizeBranding({
      title: "Northwind",
      footer: "<script>alert(1)</script>",
      logoDataUri: dataUri("png"),
    });
    expect(Object.keys(result).sort()).toEqual([
      "logoDataUri",
      "showDate",
      "subtitle",
      "title",
    ]);
  });
});
