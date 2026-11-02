import { describe, expect, it } from "vitest";
import {
  CORE_DRUM_PITCHES,
  isStandardDrumPitch,
  STANDARD_DRUM_NAMES,
  STANDARD_DRUM_PITCHES,
  visibleDrumPitchRows,
} from "./drum-pitches";

describe("standard drum pitches", () => {
  it("contains only named notation lanes", () => {
    expect(new Set(STANDARD_DRUM_PITCHES).size).toBe(
      STANDARD_DRUM_PITCHES.length,
    );
    expect(
      STANDARD_DRUM_PITCHES.every(
        (pitch) => STANDARD_DRUM_NAMES[pitch] !== undefined,
      ),
    ).toBe(true);
  });

  it("rejects percussion keys without a standard score mapping", () => {
    expect(isStandardDrumPitch(36)).toBe(true);
    expect(isStandardDrumPitch(39)).toBe(true);
    expect(isStandardDrumPitch(81)).toBe(true);
    expect(isStandardDrumPitch(82)).toBe(false);
    expect(isStandardDrumPitch(127)).toBe(false);
  });

  it("adds detected auxiliary percussion without adding empty lanes", () => {
    const rows = visibleDrumPitchRows([39, 81, 82]);

    expect(rows).toContain(39);
    expect(rows).toContain(81);
    expect(rows).not.toContain(82);
    expect(rows).toHaveLength(CORE_DRUM_PITCHES.length + 2);
  });
});
