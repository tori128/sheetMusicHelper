import { describe, expect, it } from "vitest";
import {
  contextTimeForTimelineTime,
  createPlaybackStartAnchor,
  PLAYBACK_START_LEAD_SEC,
  timelineTimeAtContextTime,
  type TimelinePlaybackStartAnchor,
} from "./playback-transport";

describe("playback transport", () => {
  it("reserves one future output time for Wave and SoundFont", () => {
    expect(createPlaybackStartAnchor(12.5, 80)).toEqual({
      contextTimeSec: 12.5,
      sourceTimeSec: 80,
      audibleContextTimeSec: 12.5 + PLAYBACK_START_LEAD_SEC,
    });
  });

  it("maps an edited timeline to the shared AudioContext clock", () => {
    const anchor: TimelinePlaybackStartAnchor = {
      contextTimeSec: 12.5,
      sourceTimeSec: 80,
      timelineTimeSec: 80.25,
      audibleContextTimeSec: 12.5 + PLAYBACK_START_LEAD_SEC,
    };

    expect(contextTimeForTimelineTime(anchor, 80.3)).toBeCloseTo(12.55, 10);
    expect(timelineTimeAtContextTime(anchor, 12.55)).toBeCloseTo(80.3, 10);
  });

  it("does not schedule elapsed timeline positions in the past", () => {
    const anchor: TimelinePlaybackStartAnchor = {
      contextTimeSec: 4,
      sourceTimeSec: 9,
      timelineTimeSec: 10,
      audibleContextTimeSec: 4 + PLAYBACK_START_LEAD_SEC,
    };

    expect(contextTimeForTimelineTime(anchor, 9.5)).toBe(4);
    expect(timelineTimeAtContextTime(anchor, 3.5)).toBe(10);
  });
});
