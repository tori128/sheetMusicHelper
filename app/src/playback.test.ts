import { describe, expect, it } from "vitest";
import { formatPlaybackTime } from "./playback";

describe("formatPlaybackTime", () => {
  it("formats minutes, seconds and milliseconds", () => {
    expect(formatPlaybackTime(125.678)).toBe("02:05.677");
  });

  it("normalizes invalid and negative values", () => {
    expect(formatPlaybackTime(-1)).toBe("00:00.000");
    expect(formatPlaybackTime(Number.NaN)).toBe("00:00.000");
  });
});
