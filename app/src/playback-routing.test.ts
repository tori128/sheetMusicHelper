import { describe, expect, it } from "vitest";
import {
  isPlaybackActive,
  requiresSourceMixer,
  resolvePlaybackRouting,
} from "./playback-routing";
import type { PlaybackSource } from "./soundfont-playback";

describe("resolvePlaybackRouting", () => {
  it.each<{
    source: PlaybackSource;
    sourceMixEnabled: boolean;
    transcriptionMixEnabled: boolean;
    metronomeEnabled: boolean;
    soundFontSource: PlaybackSource;
    sourceMixerSource: PlaybackSource;
    synchronized: boolean;
    requiresSoundFont: boolean;
  }>([
    {
      source: "original",
      sourceMixEnabled: false,
      transcriptionMixEnabled: false,
      metronomeEnabled: false,
      soundFontSource: "original",
      sourceMixerSource: "original",
      synchronized: false,
      requiresSoundFont: false,
    },
    {
      source: "transcription",
      sourceMixEnabled: false,
      transcriptionMixEnabled: false,
      metronomeEnabled: false,
      soundFontSource: "transcription",
      sourceMixerSource: "transcription",
      synchronized: false,
      requiresSoundFont: true,
    },
    {
      source: "comparison",
      sourceMixEnabled: false,
      transcriptionMixEnabled: false,
      metronomeEnabled: false,
      soundFontSource: "comparison",
      sourceMixerSource: "comparison",
      synchronized: true,
      requiresSoundFont: true,
    },
    {
      source: "original",
      sourceMixEnabled: false,
      transcriptionMixEnabled: true,
      metronomeEnabled: false,
      soundFontSource: "transcription",
      sourceMixerSource: "original",
      synchronized: true,
      requiresSoundFont: true,
    },
    {
      source: "transcription",
      sourceMixEnabled: true,
      transcriptionMixEnabled: false,
      metronomeEnabled: false,
      soundFontSource: "transcription",
      sourceMixerSource: "original",
      synchronized: true,
      requiresSoundFont: true,
    },
    {
      source: "original",
      sourceMixEnabled: false,
      transcriptionMixEnabled: false,
      metronomeEnabled: true,
      soundFontSource: "original",
      sourceMixerSource: "original",
      synchronized: true,
      requiresSoundFont: true,
    },
  ])("resolves $source routing", (expected) => {
    const routing = resolvePlaybackRouting(expected);

    expect(routing).toEqual({
      source: expected.source,
      soundFontSource: expected.soundFontSource,
      sourceMixerSource: expected.sourceMixerSource,
      synchronized: expected.synchronized,
      usesAudioContextClock:
        expected.synchronized || expected.soundFontSource !== "original",
      requiresSoundFont: expected.requiresSoundFont,
    });
  });

  it("uses a source mixer for synchronized, initialized, or stem-filtered playback", () => {
    const directOriginal = resolvePlaybackRouting({
      source: "original",
      sourceMixEnabled: false,
      transcriptionMixEnabled: false,
      metronomeEnabled: false,
    });
    const comparison = resolvePlaybackRouting({
      source: "comparison",
      sourceMixEnabled: false,
      transcriptionMixEnabled: false,
      metronomeEnabled: false,
    });

    expect(requiresSourceMixer(directOriginal, false, false)).toBe(false);
    expect(requiresSourceMixer(directOriginal, true, false)).toBe(true);
    expect(requiresSourceMixer(directOriginal, false, true)).toBe(true);
    expect(requiresSourceMixer(comparison, false, false)).toBe(true);
  });
});

describe("isPlaybackActive", () => {
  it.each([
    [false, true, false, false],
    [true, true, false, true],
    [false, false, false, true],
    [false, true, true, true],
  ])(
    "resolves renderer=%s mediaPaused=%s mixer=%s",
    (renderer, mediaPaused, mixer, expected) => {
      expect(isPlaybackActive(renderer, mediaPaused, mixer)).toBe(expected);
    },
  );
});
