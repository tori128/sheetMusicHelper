import { describe, expect, it } from "vitest";
import type { ProjectNote, ProjectTrack } from "./types";
import { estimateKeySignature } from "./score-key-estimation";

const track = {
  id: "piano",
  kind: "pitched",
} as ProjectTrack;

function note(pitch: number, duration: number): ProjectNote {
  return {
    id: `note-${pitch}`,
    sourceInstrumentId: "acoustic_piano",
    trackId: track.id,
    pitch,
    rawStartSec: 0,
    rawEndSec: duration,
    startSec: 0,
    endSec: duration,
    velocity: 100,
  };
}

describe("estimateKeySignature", () => {
  it("returns C major for a C-major pitch distribution", () => {
    const result = estimateKeySignature(
      [note(60, 2), note(64, 1.5), note(67, 1.75), note(65, 0.5)],
      [track],
    );

    expect(result).toMatchObject({ keyFifths: 0, keyMode: "major" });
  });

  it("ignores drum tracks and returns null without pitched notes", () => {
    expect(
      estimateKeySignature(
        [{ ...note(36, 1), trackId: "drums" }],
        [{ id: "drums", kind: "drums" } as ProjectTrack],
      ),
    ).toBeNull();
  });
});
