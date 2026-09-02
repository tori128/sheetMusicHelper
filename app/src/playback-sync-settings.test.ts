import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_PLAYBACK_DELAY_MS,
  MAX_SOURCE_PLAYBACK_DELAY_MS,
  MIN_SOURCE_PLAYBACK_DELAY_MS,
  normalizeSourcePlaybackDelayMs,
  readSourcePlaybackDelayMs,
  splitPlaybackSynchronizationDelayMs,
  writeSourcePlaybackDelayMs,
} from "./playback-sync-settings";

afterEach(() => window.localStorage.clear());

describe("playback synchronization settings", () => {
  it("uses a 15 ms source delay by default", () => {
    expect(readSourcePlaybackDelayMs()).toBe(DEFAULT_SOURCE_PLAYBACK_DELAY_MS);
  });

  it("persists integer values within the supported range", () => {
    expect(writeSourcePlaybackDelayMs(18.6)).toBe(19);
    expect(readSourcePlaybackDelayMs()).toBe(19);
    expect(normalizeSourcePlaybackDelayMs(-18.6)).toBe(-19);
    expect(normalizeSourcePlaybackDelayMs(-500)).toBe(
      MIN_SOURCE_PLAYBACK_DELAY_MS,
    );
    expect(normalizeSourcePlaybackDelayMs(500)).toBe(
      MAX_SOURCE_PLAYBACK_DELAY_MS,
    );
  });

  it("maps positive values to the source and negative values to transcription", () => {
    expect(splitPlaybackSynchronizationDelayMs(35)).toEqual({
      sourceDelayMs: 35,
      transcriptionDelayMs: 0,
    });
    expect(splitPlaybackSynchronizationDelayMs(-28)).toEqual({
      sourceDelayMs: 0,
      transcriptionDelayMs: 28,
    });
    expect(splitPlaybackSynchronizationDelayMs(0)).toEqual({
      sourceDelayMs: 0,
      transcriptionDelayMs: 0,
    });
  });
});
