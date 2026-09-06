import { describe, expect, it } from "vitest";

import {
  buildFilmstripView,
  formatFrameTime,
  framePositionPercent,
  frameAltText,
  lcpMarkerPercent,
} from "@/lib/reports/filmstrip-view";
import type { FilmstripData, FilmstripFrame } from "@/lib/reports/types";

/** A stand-in for the ~33 KB inline JPEG a real frame carries. */
const JPEG = "data:image/jpeg;base64,AAAA";

function frame(timingMs: number, isLcp = false): FilmstripFrame {
  return { timingMs, data: JPEG, isLcp };
}

/** A well-formed `FilmstripData`; `timelineMs` defaults to the last frame's timing. */
function filmstrip(patch: Partial<FilmstripData> = {}): FilmstripData {
  const frames = patch.frames ?? [frame(0), frame(1000), frame(2000, true)];
  return {
    frames,
    lcpMs: null,
    timelineMs: frames.length > 0 ? frames[frames.length - 1].timingMs : null,
    unavailable: false,
    ...patch,
  };
}

describe("formatFrameTime", () => {
  it("prints whole milliseconds below one second", () => {
    expect(formatFrameTime(0)).toBe("0 ms");
    expect(formatFrameTime(1)).toBe("1 ms");
    expect(formatFrameTime(750.4)).toBe("750 ms");
    expect(formatFrameTime(999)).toBe("999 ms");
  });

  it("crosses to seconds on the rounded value, never printing '1000 ms'", () => {
    // The threshold is tested after rounding, so 999.6 cannot render as a
    // millisecond figure that contradicts its own unit.
    expect(formatFrameTime(999.6)).toBe("1.0 s");
    expect(formatFrameTime(1000)).toBe("1.0 s");
  });

  it("prints one decimal of seconds above the boundary", () => {
    expect(formatFrameTime(1049)).toBe("1.0 s");
    expect(formatFrameTime(2400)).toBe("2.4 s");
    expect(formatFrameTime(12345)).toBe("12.3 s");
  });

  it("reports a non-finite timing as not recorded", () => {
    expect(formatFrameTime(Number.NaN)).toBe("—");
    expect(formatFrameTime(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("prints a negative timing as recorded rather than clamping it", () => {
    // Formatting reports the trace; only placement has to stay inside the rail.
    expect(formatFrameTime(-5)).toBe("-5 ms");
  });
});

describe("framePositionPercent", () => {
  it("places a frame proportionally along the axis", () => {
    expect(framePositionPercent(0, 4000)).toBe(0);
    expect(framePositionPercent(1000, 4000)).toBe(25);
    expect(framePositionPercent(4000, 4000)).toBe(100);
  });

  it("rounds to two decimals", () => {
    expect(framePositionPercent(1000, 7000)).toBe(14.29);
  });

  it("returns 0 rather than NaN when the timeline is null", () => {
    const pct = framePositionPercent(1200, null);
    expect(pct).toBe(0);
    expect(Number.isNaN(pct)).toBe(false);
  });

  it("returns 0 rather than Infinity when the timeline is zero", () => {
    // A single frame at navigation start, or every frame sharing one timing.
    const pct = framePositionPercent(0, 0);
    expect(pct).toBe(0);
    expect(Number.isFinite(pct)).toBe(true);
    expect(framePositionPercent(500, 0)).toBe(0);
  });

  it("clamps a frame outside the axis instead of overflowing the rail", () => {
    expect(framePositionPercent(9000, 4000)).toBe(100);
    expect(framePositionPercent(-200, 4000)).toBe(0);
  });

  it("survives non-finite inputs on either side", () => {
    expect(framePositionPercent(Number.NaN, 4000)).toBe(0);
    expect(framePositionPercent(1000, Number.NaN)).toBe(0);
    expect(framePositionPercent(1000, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("lcpMarkerPercent", () => {
  it("places a recorded LCP on the axis", () => {
    expect(lcpMarkerPercent(2000, 4000)).toBe(50);
    expect(lcpMarkerPercent(0, 4000)).toBe(0);
    expect(lcpMarkerPercent(4000, 4000)).toBe(100);
  });

  it("withholds the tick when there is no LCP to mark", () => {
    expect(lcpMarkerPercent(null, 4000)).toBeNull();
    expect(lcpMarkerPercent(Number.NaN, 4000)).toBeNull();
  });

  it("withholds the tick when the axis is degenerate", () => {
    expect(lcpMarkerPercent(1200, null)).toBeNull();
    expect(lcpMarkerPercent(1200, 0)).toBeNull();
  });

  it("withholds the tick — rather than clamping — for an LCP past the last frame", () => {
    // Pinning it to 100% would claim the LCP coincided with the final frame.
    expect(lcpMarkerPercent(5000, 4000)).toBeNull();
  });
});

describe("frameAltText", () => {
  it("describes a plain frame by its capture time and position", () => {
    expect(frameAltText({ timingMs: 1200, ordinal: 3, total: 8, isLcp: false })).toBe(
      "Page as rendered at 1.2 s, frame 3 of 8",
    );
  });

  it("names the largest contentful paint on the LCP frame", () => {
    expect(frameAltText({ timingMs: 2400, ordinal: 5, total: 8, isLcp: true })).toBe(
      "Page as rendered at 2.4 s, frame 5 of 8, largest contentful paint",
    );
  });

  it("uses the same millisecond/second thresholds as the visible label", () => {
    expect(frameAltText({ timingMs: 0, ordinal: 1, total: 8, isLcp: false })).toBe(
      "Page as rendered at 0 ms, frame 1 of 8",
    );
  });
});

describe("buildFilmstripView", () => {
  it("resolves a typical eight-frame strip", () => {
    const frames = Array.from({ length: 8 }, (_, i) => frame(i * 500, i === 4));
    const view = buildFilmstripView(
      filmstrip({ frames, lcpMs: 2000, timelineMs: 3500 }),
    );

    expect(view.state).toBe("ready");
    expect(view.frameCount).toBe(8);
    expect(view.frames).toHaveLength(8);
    expect(view.frames[0]?.positionPct).toBe(0);
    expect(view.frames[7]?.positionPct).toBe(100);
    expect(view.lcpLabel).toBe("2.0 s");
    expect(view.lcpPositionPct).toBe(57.14);
    expect(view.lcpFrameOrdinal).toBe(5);
    expect(view.timelineLabel).toBe("3.5 s");
  });

  it("gives every frame a unique key and a 1-based ordinal", () => {
    const view = buildFilmstripView(filmstrip());
    expect(view.frames.map((f) => f.ordinal)).toEqual([1, 2, 3]);
    expect(new Set(view.frames.map((f) => f.key)).size).toBe(3);
  });

  it("keys frames uniquely even when every frame shares one timing", () => {
    // Degenerate but well-formed: keys are ordinal-prefixed, so they can't collide.
    const view = buildFilmstripView(
      filmstrip({ frames: [frame(0), frame(0), frame(0)], timelineMs: 0 }),
    );
    expect(new Set(view.frames.map((f) => f.key)).size).toBe(3);
    expect(view.frames.every((f) => f.positionPct === 0)).toBe(true);
    expect(view.frames.every((f) => f.timeLabel === "0 ms")).toBe(true);
  });

  it("handles a single frame without dividing by zero", () => {
    const view = buildFilmstripView(
      filmstrip({ frames: [frame(0)], timelineMs: 0, lcpMs: null }),
    );
    expect(view.state).toBe("ready");
    expect(view.frames[0]?.positionPct).toBe(0);
    expect(view.frames[0]?.alt).toBe("Page as rendered at 0 ms, frame 1 of 1");
    expect(view.timelineLabel).toBe("0 ms");
    expect(view.lcpPositionPct).toBeNull();
  });

  it("marks nothing when the report recorded no LCP", () => {
    const frames = [frame(0), frame(1000), frame(2000)];
    const view = buildFilmstripView(filmstrip({ frames, lcpMs: null }));
    expect(view.lcpLabel).toBeNull();
    expect(view.lcpPositionPct).toBeNull();
    expect(view.lcpFrameOrdinal).toBeNull();
    expect(view.frames.some((f) => f.isLcp)).toBe(false);
    expect(view.frames.every((f) => !f.alt.includes("largest contentful"))).toBe(
      true,
    );
  });

  it("still reports an LCP value it cannot place on the axis", () => {
    const view = buildFilmstripView(
      filmstrip({ frames: [frame(0), frame(1000)], timelineMs: 1000, lcpMs: 4000 }),
    );
    expect(view.lcpLabel).toBe("4.0 s");
    expect(view.lcpPositionPct).toBeNull();
  });

  it("distinguishes 'the report has no such audit' from 'the audit captured nothing'", () => {
    const missing = buildFilmstripView(
      filmstrip({ frames: [], timelineMs: null, unavailable: true }),
    );
    const captured = buildFilmstripView(
      filmstrip({ frames: [], timelineMs: null, unavailable: false }),
    );
    expect(missing.state).toBe("unavailable");
    expect(captured.state).toBe("empty");
    expect(missing.frames).toEqual([]);
    expect(captured.frameCount).toBe(0);
  });

  it("never hides real frames behind a stale unavailable flag", () => {
    const view = buildFilmstripView(
      filmstrip({ frames: [frame(0), frame(900)], unavailable: true }),
    );
    expect(view.state).toBe("ready");
    expect(view.frames).toHaveLength(2);
  });

  it("reports the first LCP frame when a report marks more than one", () => {
    const view = buildFilmstripView(
      filmstrip({ frames: [frame(0), frame(500, true), frame(1000, true)] }),
    );
    expect(view.lcpFrameOrdinal).toBe(2);
  });

  it("passes each frame's inline data URI straight through", () => {
    const view = buildFilmstripView(filmstrip());
    expect(view.frames.every((f) => f.src === JPEG)).toBe(true);
  });
});
