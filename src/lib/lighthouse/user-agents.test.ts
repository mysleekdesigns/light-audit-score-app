import { describe, expect, it } from "vitest";

import {
  USER_AGENT_PRESETS,
  USER_AGENT_PRESET_LABELS,
  resolveUserAgentPreset,
  sanitizeUserAgentPreset,
} from "@/lib/lighthouse/user-agents";

describe("user-agent presets", () => {
  it("has a label for every preset", () => {
    for (const preset of USER_AGENT_PRESETS) {
      expect(typeof USER_AGENT_PRESET_LABELS[preset]).toBe("string");
    }
  });

  it("resolves 'default' / unknown keys to undefined (no override)", () => {
    expect(resolveUserAgentPreset("default")).toBeUndefined();
    expect(resolveUserAgentPreset(undefined)).toBeUndefined();
  });

  it("resolves non-default presets to a matching Chrome UA string", () => {
    const desktop = resolveUserAgentPreset("desktop-chrome");
    expect(desktop).toContain("Chrome/");
    expect(desktop).not.toContain("Mobile");

    const mobile = resolveUserAgentPreset("mobile-chrome");
    expect(mobile).toContain("Chrome/");
    expect(mobile).toContain("Mobile");
  });

  it("sanitizes arbitrary values to a valid preset key (default fallback)", () => {
    expect(sanitizeUserAgentPreset("desktop-chrome")).toBe("desktop-chrome");
    expect(sanitizeUserAgentPreset("mobile-chrome")).toBe("mobile-chrome");
    expect(sanitizeUserAgentPreset("default")).toBe("default");
    expect(sanitizeUserAgentPreset("garbage")).toBe("default");
    expect(sanitizeUserAgentPreset(123)).toBe("default");
    expect(sanitizeUserAgentPreset(null)).toBe("default");
  });
});
