import { describe, expect, it } from "vitest";
import type { ProjectNote, ProjectTrack } from "../types";
import {
  visibleNotesForRoll,
  visibleTracksForRoll,
} from "./piano-roll-visibility";

function track(
  id: string,
  kind: "pitched" | "drums" = "pitched",
  solo = false,
  mute = false,
): ProjectTrack {
  return {
    id,
    displayName: id,
    instrumentId: id,
    kind,
    color: "#112233",
    order: 1,
    midiChannel: kind === "drums" ? 10 : 1,
    gmProgram: kind === "drums" ? null : 0,
    playbackOctaveShift: 0,
    playbackVolume: 100,
    mute,
    solo,
  };
}

function note(id: string, trackId: string): ProjectNote {
  return {
    id,
    sourceInstrumentId: trackId,
    trackId,
    pitch: 60,
    rawStartSec: 0,
    rawEndSec: 1,
    startSec: 0,
    endSec: 1,
    velocity: 100,
  };
}

describe("piano-roll track visibility", () => {
  it("shows every track when Solo is inactive", () => {
    const tracks = [track("piano"), track("guitar"), track("drums", "drums")];

    expect(visibleTracksForRoll(tracks).map(({ id }) => id)).toEqual([
      "piano",
      "guitar",
      "drums",
    ]);
    expect(
      visibleNotesForRoll(
        tracks.map(({ id }) => note(`${id}-note`, id)),
        tracks,
        "pitched",
      ).map(({ trackId }) => trackId),
    ).toEqual(["piano", "guitar"]);
  });

  it("hides muted tracks and their notes when Solo is inactive", () => {
    const tracks = [
      track("piano"),
      track("guitar", "pitched", false, true),
      track("drums", "drums", false, true),
    ];
    const notes = tracks.map(({ id }) => note(`${id}-note`, id));

    expect(visibleTracksForRoll(tracks).map(({ id }) => id)).toEqual([
      "piano",
    ]);
    expect(
      visibleNotesForRoll(notes, tracks, "pitched").map(({ id }) => id),
    ).toEqual(["piano-note"]);
    expect(visibleNotesForRoll(notes, tracks, "drums")).toEqual([]);
  });

  it("shows every track and note when all tracks are muted", () => {
    const tracks = [
      track("piano", "pitched", false, true),
      track("guitar", "pitched", false, true),
      track("drums", "drums", false, true),
    ];
    const notes = tracks.map(({ id }) => note(`${id}-note`, id));

    expect(visibleTracksForRoll(tracks).map(({ id }) => id)).toEqual([
      "piano",
      "guitar",
      "drums",
    ]);
    expect(
      visibleNotesForRoll(notes, tracks, "pitched").map(({ id }) => id),
    ).toEqual(["piano-note", "guitar-note"]);
    expect(
      visibleNotesForRoll(notes, tracks, "drums").map(({ id }) => id),
    ).toEqual(["drums-note"]);
  });

  it("shows only the selected Solo track", () => {
    const tracks = [track("piano"), track("guitar", "pitched", true)];
    const notes = [note("piano-note", "piano"), note("guitar-note", "guitar")];

    expect(visibleTracksForRoll(tracks).map(({ id }) => id)).toEqual([
      "guitar",
    ]);
    expect(
      visibleNotesForRoll(notes, tracks, "pitched").map(({ id }) => id),
    ).toEqual(["guitar-note"]);
  });

  it("shows all Solo tracks and keeps roll kinds separate", () => {
    const tracks = [
      track("piano", "pitched", true),
      track("guitar"),
      track("drums", "drums", true),
    ];
    const notes = tracks.map(({ id }) => note(`${id}-note`, id));

    expect(
      visibleNotesForRoll(notes, tracks, "pitched").map(({ trackId }) => trackId),
    ).toEqual(["piano"]);
    expect(
      visibleNotesForRoll(notes, tracks, "drums").map(({ trackId }) => trackId),
    ).toEqual(["drums"]);
  });
});
