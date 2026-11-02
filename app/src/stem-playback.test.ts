import { describe, expect, it } from "vitest";
import {
  comparisonStems,
  comparisonTracks,
  playbackStemsForSource,
  playbackTracksForSource,
  stemTypeForTrack,
} from "./stem-playback";
import type { ProjectStem, ProjectTrack } from "./types";

function track(
  id: string,
  instrumentId: string,
  mute = false,
  solo = false,
): ProjectTrack {
  return {
    id,
    displayName: id,
    instrumentId,
    kind: "pitched",
    color: "#123456",
    order: 1,
    midiChannel: 1,
    gmProgram: 0,
    playbackOctaveShift: 0,
    playbackVolume: 100,
    mute,
    solo,
  };
}

function stem(
  type: ProjectStem["type"],
  mute = false,
  solo = false,
): ProjectStem {
  return {
    type,
    cachePath: `${type}.wav`,
    sha256: "a".repeat(64),
    sampleRate: 44100,
    channels: 2,
    mute,
    solo,
  };
}

describe("comparison playback groups", () => {
  it("maps related transcription instruments to one separated component", () => {
    expect(stemTypeForTrack(track("acoustic", "acoustic_guitar"))).toBe(
      "guitar",
    );
    expect(stemTypeForTrack(track("electric", "distorted_electric_guitar"))).toBe(
      "guitar",
    );
    expect(stemTypeForTrack(track("strings", "strings"))).toBe("other");
  });

  it("keeps one guitar track solo while selecting its guitar stem", () => {
    const tracks = [
      track("acoustic", "acoustic_guitar"),
      track("electric", "distorted_electric_guitar", false, true),
      track("piano", "acoustic_piano"),
    ];
    const stems = [stem("guitar"), stem("piano")];
    const groupedTracks = comparisonTracks(tracks, stems);
    const groupedStems = comparisonStems(stems, tracks);

    expect(groupedTracks.filter((candidate) => candidate.solo).map((candidate) => candidate.id)).toEqual([
      "electric",
    ]);
    expect(groupedStems.find((candidate) => candidate.type === "guitar")?.solo).toBe(true);
    expect(groupedStems.find((candidate) => candidate.type === "piano")?.solo).toBe(false);
  });

  it("applies stem controls to related tracks without expanding track controls", () => {
    const tracks = [
      track("acoustic", "acoustic_guitar", true),
      track("electric", "distorted_electric_guitar"),
      track("strings", "strings"),
    ];
    const stems = [stem("guitar"), stem("other", false, true)];
    const groupedTracks = comparisonTracks(tracks, stems);
    const groupedStems = comparisonStems(stems, tracks);

    expect(
      groupedTracks
        .filter((candidate) => candidate.instrumentId.includes("guitar"))
        .map((candidate) => ({ id: candidate.id, mute: candidate.mute })),
    ).toEqual([
      { id: "acoustic", mute: true },
      { id: "electric", mute: false },
    ]);
    expect(
      groupedTracks.find((candidate) => candidate.id === "strings"),
    ).toMatchObject({ mute: false, solo: true });
    expect(groupedStems.find((candidate) => candidate.type === "guitar"))
      .toMatchObject({ mute: false, solo: false });
    expect(groupedStems.find((candidate) => candidate.type === "other"))
      .toMatchObject({ mute: false, solo: true });
  });

  it("uses separated-source controls directly in source mode", () => {
    const tracks = [
      track("acoustic", "acoustic_guitar"),
      track("electric", "distorted_electric_guitar", false, true),
      track("piano", "acoustic_piano"),
    ];
    const stems = [stem("guitar"), stem("piano")];
    const groupedStems = comparisonStems(stems, tracks);

    expect(
      playbackStemsForSource("original", stems, groupedStems)
        .filter((candidate) => candidate.solo),
    ).toEqual([]);
  });

  it("starts single-source modes muted and exposes the inactive mix on request", () => {
    const tracks = [track("piano", "acoustic_piano", false, true)];
    const stems = [stem("piano")];

    expect(
      playbackTracksForSource("original", tracks, tracks)[0],
    ).toMatchObject({ mute: true, solo: false });
    expect(
      playbackStemsForSource("transcription", stems, stems)[0],
    ).toMatchObject({ mute: true, solo: false });
    expect(
      playbackTracksForSource("original", tracks, tracks, true)[0],
    ).toMatchObject({ mute: false, solo: true });
    expect(
      playbackStemsForSource("transcription", stems, stems, true)[0],
    ).toMatchObject({ mute: false, solo: false });
  });

});
