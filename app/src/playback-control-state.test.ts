import { describe, expect, it } from "vitest";
import type { ProjectStem, ProjectTrack } from "./types";
import {
  addStemToPlaybackControlState,
  addTrackToPlaybackControlState,
  resetPlaybackControlState,
  toggleStemMuteState,
  toggleStemSoloState,
  toggleTrackMuteState,
  toggleTrackSoloState,
} from "./playback-control-state";

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
    kind: instrumentId === "drums" ? "drums" : "pitched",
    color: "#123456",
    order: 1,
    midiChannel: instrumentId === "drums" ? 10 : 1,
    gmProgram: instrumentId === "drums" ? null : 0,
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

function controlValues(
  items: readonly { mute: boolean; solo: boolean }[],
): { mute: boolean; solo: boolean }[] {
  return items.map(({ mute, solo }) => ({ mute, solo }));
}

describe("playback control state", () => {
  const tracks = [
    track("guitar-a", "acoustic_guitar"),
    track("guitar-b", "distorted_electric_guitar"),
    track("piano", "acoustic_piano"),
  ];
  const stems = [stem("guitar"), stem("piano")];

  it("resets all controls for each playback source", () => {
    const original = resetPlaybackControlState("original", tracks, stems);
    expect(controlValues(original.tracks)).toEqual([
      { mute: true, solo: false },
      { mute: true, solo: false },
      { mute: true, solo: false },
    ]);
    expect(controlValues(original.stems)).toEqual([
      { mute: false, solo: false },
      { mute: false, solo: false },
    ]);

    const transcription = resetPlaybackControlState(
      "transcription",
      tracks,
      stems,
    );
    expect(controlValues(transcription.tracks)).toEqual([
      { mute: false, solo: false },
      { mute: false, solo: false },
      { mute: false, solo: false },
    ]);
    expect(controlValues(transcription.stems)).toEqual([
      { mute: true, solo: false },
      { mute: true, solo: false },
    ]);

    const comparison = resetPlaybackControlState("comparison", tracks, stems);
    expect(controlValues(comparison.tracks)).toEqual([
      { mute: false, solo: false },
      { mute: false, solo: false },
      { mute: false, solo: false },
    ]);
    expect(controlValues(comparison.stems)).toEqual([
      { mute: false, solo: false },
      { mute: false, solo: false },
    ]);
  });

  it("supports multiple transcription Solo tracks and individual Solo mute", () => {
    let state = resetPlaybackControlState("transcription", tracks, stems);
    state = toggleTrackSoloState(
      "transcription",
      "guitar-a",
      state.tracks,
      state.stems,
    );
    state = toggleTrackSoloState(
      "transcription",
      "piano",
      state.tracks,
      state.stems,
    );
    expect(controlValues(state.tracks)).toEqual([
      { mute: false, solo: true },
      { mute: true, solo: false },
      { mute: false, solo: true },
    ]);
    expect(state.stems.every((item) => item.mute && !item.solo)).toBe(true);

    state = toggleTrackMuteState(
      "transcription",
      "guitar-a",
      state.tracks,
      state.stems,
    );
    expect(state.tracks[0]).toMatchObject({ mute: true, solo: true });
    expect(state.tracks[2]).toMatchObject({ mute: false, solo: true });

    state = toggleTrackSoloState(
      "transcription",
      "piano",
      state.tracks,
      state.stems,
    );
    expect(state.tracks[0]).toMatchObject({ mute: true, solo: true });
    expect(state.tracks[2]).toMatchObject({ mute: true, solo: false });

    state = toggleTrackSoloState(
      "transcription",
      "guitar-a",
      state.tracks,
      state.stems,
    );
    expect(state.tracks.every((item) => !item.mute && !item.solo)).toBe(true);
    expect(state.stems.every((item) => item.mute && !item.solo)).toBe(true);
  });

  it.each(["original", "transcription"] as const)(
    "allows only Solo items to change Mute in %s mode",
    (source) => {
      let trackState = resetPlaybackControlState(source, tracks, stems);
      trackState = toggleTrackSoloState(
        source,
        "piano",
        trackState.tracks,
        trackState.stems,
      );
      trackState = toggleTrackMuteState(
        source,
        "piano",
        trackState.tracks,
        trackState.stems,
      );
      expect(trackState.tracks[2]).toMatchObject({ mute: true, solo: true });
      const trackValues = controlValues(trackState.tracks);
      trackState = toggleTrackMuteState(
        source,
        "guitar-a",
        trackState.tracks,
        trackState.stems,
      );
      expect(controlValues(trackState.tracks)).toEqual(trackValues);

      let stemState = resetPlaybackControlState(source, tracks, stems);
      stemState = toggleStemSoloState(
        source,
        "guitar",
        stemState.tracks,
        stemState.stems,
      );
      stemState = toggleStemMuteState(
        source,
        "guitar",
        stemState.tracks,
        stemState.stems,
      );
      expect(stemState.stems[0]).toMatchObject({ mute: true, solo: true });
      const stemValues = controlValues(stemState.stems);
      stemState = toggleStemMuteState(
        source,
        "piano",
        stemState.tracks,
        stemState.stems,
      );
      expect(controlValues(stemState.stems)).toEqual(stemValues);
    },
  );

  it("toggles the corresponding group in comparison Mute", () => {
    let state = resetPlaybackControlState("comparison", tracks, stems);
    state = toggleTrackMuteState(
      "comparison",
      "guitar-a",
      state.tracks,
      state.stems,
    );
    expect(controlValues(state.tracks)).toEqual([
      { mute: true, solo: false },
      { mute: true, solo: false },
      { mute: false, solo: false },
    ]);
    expect(controlValues(state.stems)).toEqual([
      { mute: true, solo: false },
      { mute: false, solo: false },
    ]);

    state = toggleStemMuteState(
      "comparison",
      "guitar",
      state.tracks,
      state.stems,
    );
    expect(state.tracks.every((item) => !item.mute && !item.solo)).toBe(true);
    expect(state.stems.every((item) => !item.mute && !item.solo)).toBe(true);
  });

  it("selects corresponding groups and multiple parts in comparison Solo", () => {
    let state = resetPlaybackControlState("comparison", tracks, stems);
    state = toggleTrackSoloState(
      "comparison",
      "guitar-a",
      state.tracks,
      state.stems,
    );
    expect(controlValues(state.tracks)).toEqual([
      { mute: false, solo: true },
      { mute: true, solo: false },
      { mute: true, solo: false },
    ]);
    expect(controlValues(state.stems)).toEqual([
      { mute: false, solo: true },
      { mute: true, solo: false },
    ]);

    state = toggleTrackSoloState(
      "comparison",
      "piano",
      state.tracks,
      state.stems,
    );
    expect(state.tracks[0]).toMatchObject({ mute: false, solo: true });
    expect(state.tracks[2]).toMatchObject({ mute: false, solo: true });
    expect(state.stems.every((item) => !item.mute && item.solo)).toBe(true);

    state = toggleTrackSoloState(
      "comparison",
      "guitar-a",
      state.tracks,
      state.stems,
    );
    expect(state.tracks[2]).toMatchObject({ mute: false, solo: true });
    expect(state.stems[1]).toMatchObject({ mute: false, solo: true });
    expect(state.stems[0]).toMatchObject({ mute: true, solo: false });
  });

  it("unmutes a comparison Mute group when another related track becomes Solo", () => {
    let state = resetPlaybackControlState("comparison", tracks, stems);
    state = toggleTrackSoloState(
      "comparison",
      "guitar-a",
      state.tracks,
      state.stems,
    );
    state = toggleTrackMuteState(
      "comparison",
      "guitar-a",
      state.tracks,
      state.stems,
    );
    expect(state.tracks[0]).toMatchObject({ mute: true, solo: true });
    expect(state.stems[0]).toMatchObject({ mute: true, solo: true });

    state = toggleTrackSoloState(
      "comparison",
      "guitar-b",
      state.tracks,
      state.stems,
    );
    expect(state.tracks[0]).toMatchObject({ mute: false, solo: true });
    expect(state.tracks[1]).toMatchObject({ mute: false, solo: true });
    expect(state.stems[0]).toMatchObject({ mute: false, solo: true });
  });

  it("selects every related transcription track from a comparison stem", () => {
    let state = resetPlaybackControlState("comparison", tracks, stems);
    state = toggleStemSoloState(
      "comparison",
      "guitar",
      state.tracks,
      state.stems,
    );
    expect(controlValues(state.tracks)).toEqual([
      { mute: false, solo: true },
      { mute: false, solo: true },
      { mute: true, solo: false },
    ]);
    expect(state.stems[0]).toMatchObject({ mute: false, solo: true });

    state = toggleStemSoloState(
      "comparison",
      "guitar",
      state.tracks,
      state.stems,
    );
    expect(state.tracks.every((item) => !item.mute && !item.solo)).toBe(true);
    expect(state.stems.every((item) => !item.mute && !item.solo)).toBe(true);
  });

  it("changes transcription controls without a separated source", () => {
    let state = resetPlaybackControlState("comparison", tracks, []);
    state = toggleTrackMuteState(
      "comparison",
      "guitar-a",
      state.tracks,
      state.stems,
    );
    expect(state.tracks[0].mute).toBe(true);
    expect(state.tracks[1].mute).toBe(false);
    expect(state.stems).toEqual([]);

    state = toggleTrackSoloState(
      "comparison",
      "piano",
      state.tracks,
      state.stems,
    );
    expect(state.tracks[2]).toMatchObject({ mute: false, solo: true });
    expect(state.stems).toEqual([]);
  });

  it.each([
    ["original", true, false],
    ["transcription", false, true],
    ["comparison", false, false],
  ] as const)(
    "applies %s mode to parts added after mode selection",
    (source, trackMute, stemMute) => {
      let state = resetPlaybackControlState(source, [], []);
      state = addTrackToPlaybackControlState(
        source,
        track("piano", "acoustic_piano"),
        state.tracks,
        state.stems,
      );
      state = addStemToPlaybackControlState(
        source,
        stem("piano"),
        state.tracks,
        state.stems,
      );
      expect(state.tracks[0]).toMatchObject({
        mute: trackMute,
        solo: false,
      });
      expect(state.stems[0]).toMatchObject({
        mute: stemMute,
        solo: false,
      });
    },
  );

  it.each([
    ["original", false],
    ["transcription", true],
  ] as const)(
    "applies an active track Solo only to new tracks in %s mode",
    (source, expectedStemMute) => {
      let state = resetPlaybackControlState(source, tracks, stems);
      state = toggleTrackSoloState(
        source,
        "piano",
        state.tracks,
        state.stems,
      );
      state = addTrackToPlaybackControlState(
        source,
        track("bass", "electric_bass"),
        state.tracks,
        state.stems,
      );
      state = addStemToPlaybackControlState(
        source,
        stem("bass"),
        state.tracks,
        state.stems,
      );
      expect(state.tracks.at(-1)).toMatchObject({ mute: true, solo: false });
      expect(state.stems.at(-1)).toMatchObject({
        mute: expectedStemMute,
        solo: false,
      });
    },
  );

  it.each(["original", "transcription"] as const)(
    "supports multiple track and separated-source Solo selections in %s mode",
    (source) => {
      let trackState = resetPlaybackControlState(source, tracks, stems);
      trackState = toggleTrackSoloState(
        source,
        "guitar-a",
        trackState.tracks,
        trackState.stems,
      );
      trackState = toggleTrackSoloState(
        source,
        "piano",
        trackState.tracks,
        trackState.stems,
      );
      expect(controlValues(trackState.tracks)).toEqual([
        { mute: false, solo: true },
        { mute: true, solo: false },
        { mute: false, solo: true },
      ]);
      expect(controlValues(trackState.stems)).toEqual(
        controlValues(resetPlaybackControlState(source, tracks, stems).stems),
      );

      let stemState = resetPlaybackControlState(source, tracks, stems);
      stemState = toggleStemSoloState(
        source,
        "guitar",
        stemState.tracks,
        stemState.stems,
      );
      stemState = toggleStemSoloState(
        source,
        "piano",
        stemState.tracks,
        stemState.stems,
      );
      expect(controlValues(stemState.tracks)).toEqual(
        controlValues(resetPlaybackControlState(source, tracks, stems).tracks),
      );
      expect(controlValues(stemState.stems)).toEqual([
        { mute: false, solo: true },
        { mute: false, solo: true },
      ]);
    },
  );

  it.each(["original", "transcription"] as const)(
    "toggles track and separated-source Mute independently in %s mode",
    (source) => {
      let state = resetPlaybackControlState(source, tracks, stems);
      const originalTrackMute = state.tracks[0].mute;
      const siblingTrackMute = state.tracks[1].mute;
      const originalStemMute = state.stems[0].mute;
      state = toggleTrackMuteState(
        source,
        "guitar-a",
        state.tracks,
        state.stems,
      );
      expect(state.tracks[0].mute).toBe(!originalTrackMute);
      expect(state.tracks[1].mute).toBe(siblingTrackMute);
      expect(state.stems[0].mute).toBe(originalStemMute);
      state = toggleStemMuteState(
        source,
        "guitar",
        state.tracks,
        state.stems,
      );
      expect(state.stems[0].mute).toBe(!originalStemMute);
      expect(state.tracks[0].mute).toBe(!originalTrackMute);
    },
  );

  it("synchronizes a comparison Solo when its counterpart is added later", () => {
    let state = resetPlaybackControlState("comparison", tracks, []);
    state = toggleTrackSoloState(
      "comparison",
      "guitar-a",
      state.tracks,
      state.stems,
    );
    state = addStemToPlaybackControlState(
      "comparison",
      stem("guitar"),
      state.tracks,
      state.stems,
    );
    expect(state.stems[0]).toMatchObject({ mute: false, solo: true });
    expect(state.tracks[0]).toMatchObject({ mute: false, solo: true });
    expect(state.tracks[1]).toMatchObject({ mute: true, solo: false });

    state = addTrackToPlaybackControlState(
      "comparison",
      track("guitar-c", "clean_electric_guitar"),
      state.tracks,
      state.stems,
    );
    expect(state.tracks.at(-1)).toMatchObject({ mute: false, solo: true });
  });

  it.each(["original", "transcription", "comparison"] as const)(
    "clears track Mute after the last track Solo is cleared in %s mode",
    (source) => {
      let state = resetPlaybackControlState(source, tracks, stems);
      state = toggleTrackSoloState(
        source,
        "piano",
        state.tracks,
        state.stems,
      );
      state = toggleTrackSoloState(
        source,
        "piano",
        state.tracks,
        state.stems,
      );
      expect(state.tracks.every((item) => !item.mute && !item.solo)).toBe(true);
      const expectedStems =
        source === "comparison"
          ? stems
          : resetPlaybackControlState(source, tracks, stems).stems;
      expect(controlValues(state.stems)).toEqual(controlValues(expectedStems));
    },
  );

  it.each(["original", "transcription", "comparison"] as const)(
    "clears separated-source Mute after the last separated-source Solo is cleared in %s mode",
    (source) => {
      let state = resetPlaybackControlState(source, tracks, stems);
      state = toggleStemSoloState(
        source,
        "guitar",
        state.tracks,
        state.stems,
      );
      state = toggleStemMuteState(
        source,
        "guitar",
        state.tracks,
        state.stems,
      );
      expect(state.stems[0]).toMatchObject({ mute: true, solo: true });
      state = toggleStemSoloState(
        source,
        "guitar",
        state.tracks,
        state.stems,
      );
      expect(state.stems.every((item) => !item.mute && !item.solo)).toBe(true);
      const expectedTracks =
        source === "comparison"
          ? tracks
          : resetPlaybackControlState(source, tracks, stems).tracks;
      expect(controlValues(state.tracks)).toEqual(controlValues(expectedTracks));
    },
  );

  it.each(["original", "transcription", "comparison"] as const)(
    "allows a Solo track to change Mute and rejects a non-Solo track in %s mode",
    (source) => {
      let state = resetPlaybackControlState(source, tracks, stems);
      state = toggleTrackSoloState(
        source,
        "piano",
        state.tracks,
        state.stems,
      );
      state = toggleTrackMuteState(
        source,
        "piano",
        state.tracks,
        state.stems,
      );
      expect(state.tracks[2]).toMatchObject({ mute: true, solo: true });
      const before = controlValues([...state.tracks, ...state.stems]);
      state = toggleTrackMuteState(
        source,
        "guitar-a",
        state.tracks,
        state.stems,
      );
      expect(controlValues([...state.tracks, ...state.stems])).toEqual(before);
    },
  );
});
