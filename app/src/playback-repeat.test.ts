import { describe, expect, it } from "vitest";
import {
  hasMinimumAbRepeatDuration,
  MINIMUM_AB_REPEAT_DURATION_SEC,
  repeatStartAtPosition,
  resolvePlaybackRepeatRange,
  type PlaybackRepeatSettings,
} from "./playback-repeat";

const DEFAULT_SETTINGS: PlaybackRepeatSettings = {
  mode: "off",
  aSec: null,
  bSec: null,
  fullStartSec: 0,
  fullEndSec: 30,
};

describe("playback repeat", () => {
  it("resolves the complete playable timeline", () => {
    expect(
      resolvePlaybackRepeatRange({
        ...DEFAULT_SETTINGS,
        mode: "all",
        fullStartSec: 0.25,
      }),
    ).toEqual({ startSec: 0.25, endSec: 30 });
  });

  it("resolves an A-B range and clamps it to the playable timeline", () => {
    expect(
      resolvePlaybackRepeatRange({
        ...DEFAULT_SETTINGS,
        mode: "ab",
        aSec: -1,
        bSec: 40,
      }),
    ).toEqual({ startSec: 0, endSec: 30 });
  });

  it("rejects an incomplete or shorter than 100 ms A-B range", () => {
    expect(
      resolvePlaybackRepeatRange({
        ...DEFAULT_SETTINGS,
        mode: "ab",
        aSec: 2,
        bSec: null,
      }),
    ).toBeNull();
    expect(
      resolvePlaybackRepeatRange({
        ...DEFAULT_SETTINGS,
        mode: "ab",
        aSec: 2,
        bSec: 2 + MINIMUM_AB_REPEAT_DURATION_SEC - 0.001,
      }),
    ).toBeNull();
    expect(hasMinimumAbRepeatDuration(5, 5.1)).toBe(true);
  });

  it("returns the repeat start only at or after the repeat end", () => {
    const range = { startSec: 2, endSec: 5 };
    expect(repeatStartAtPosition(4.999, range)).toBeNull();
    expect(repeatStartAtPosition(5, range)).toBe(2);
    expect(repeatStartAtPosition(5.2, range)).toBe(2);
    expect(repeatStartAtPosition(Number.NaN, range)).toBeNull();
  });
});
