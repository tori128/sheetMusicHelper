import { describe, expect, it } from "vitest";
import type { ProjectNote, ProjectTrack } from "../types";
import {
  estimateChordSpans,
  estimateChordSpansAsync,
} from "./chord-estimation";

const pitchedTrack: ProjectTrack = {
  id: "piano",
  displayName: "Piano",
  instrumentId: "acoustic_piano",
  kind: "pitched",
  color: "#ffffff",
  order: 1,
  midiChannel: 1,
  gmProgram: 0,
  playbackOctaveShift: 0,
  playbackVolume: 100,
  mute: false,
  solo: false,
};

const drumTrack: ProjectTrack = {
  ...pitchedTrack,
  id: "drums",
  displayName: "Drums",
  instrumentId: "drums",
  kind: "drums",
  midiChannel: 10,
  gmProgram: null,
};

const bassTrack: ProjectTrack = {
  ...pitchedTrack,
  id: "bass",
  displayName: "Bass",
  instrumentId: "electric_bass",
  midiChannel: 2,
  gmProgram: 33,
};

function note(
  id: string,
  trackId: string,
  pitch: number,
  startSec: number,
  endSec: number,
): ProjectNote {
  return {
    id,
    sourceInstrumentId: trackId,
    trackId,
    pitch,
    rawStartSec: startSec,
    rawEndSec: endSec,
    startSec,
    endSec,
    velocity: 100,
  };
}

describe("estimateChordSpans", () => {
  it("reports asynchronous progress without changing the result", async () => {
    const notes = [60, 64, 67].map((pitch) =>
      note(`c-${pitch}`, pitchedTrack.id, pitch, 0, 1),
    );
    const progress: Array<{ completed: number; total: number }> = [];

    const result = await estimateChordSpansAsync(
      notes,
      [pitchedTrack],
      120,
      0,
      4,
      4,
      {
        onProgress: (update) => progress.push(update),
      },
    );

    expect(result).toEqual(
      estimateChordSpans(notes, [pitchedTrack], 120, 0, 4, 4),
    );
    expect(progress[0]).toEqual({ completed: 0, total: 5 });
    expect(progress.at(-1)).toEqual({ completed: 5, total: 5 });
  });

  it("estimates every two beats and joins the same chord inside a measure", () => {
    const notes = [
      ...[60, 64, 67].map((pitch) =>
        note(`c-${pitch}`, pitchedTrack.id, pitch, 0, 2),
      ),
      ...[57, 60, 64].map((pitch) =>
        note(`am-${pitch}`, pitchedTrack.id, pitch, 2, 3),
      ),
      note("ignored-drum", drumTrack.id, 38, 0, 3),
    ];

    expect(
      estimateChordSpans(notes, [pitchedTrack, drumTrack], 120, 0, 4, 4),
    ).toEqual([
      {
        measureNumber: 1,
        startBeat: 1,
        beatLength: 4,
        startSec: 0,
        endSec: 2,
        label: "C",
      },
      {
        measureNumber: 2,
        startBeat: 1,
        beatLength: 2,
        startSec: 2,
        endSec: 3,
        label: "Am",
      },
    ]);
  });

  it("keeps different half-measure chords separate", () => {
    const notes = [
      ...[60, 64, 67].map((pitch) =>
        note(`c-${pitch}`, pitchedTrack.id, pitch, 0, 1),
      ),
      ...[65, 69, 72].map((pitch) =>
        note(`f-${pitch}`, pitchedTrack.id, pitch, 1, 2),
      ),
    ];

    expect(
      estimateChordSpans(notes, [pitchedTrack], 120, 0, 4, 4).map(
        ({ label, startBeat, beatLength }) => ({
          label,
          startBeat,
          beatLength,
        }),
      ),
    ).toEqual([
      { label: "C", startBeat: 1, beatLength: 2 },
      { label: "F", startBeat: 3, beatLength: 2 },
    ]);
  });

  it("uses the complete two-beat interval rather than only its first notes", () => {
    const notes = [
      note("c", pitchedTrack.id, 60, 0, 0.34),
      note("e", pitchedTrack.id, 64, 0.33, 0.67),
      note("g", pitchedTrack.id, 67, 0.66, 1),
    ];

    expect(
      estimateChordSpans(notes, [pitchedTrack], 120, 0, 4, 4).map(
        ({ label }) => label,
      ),
    ).toEqual(["C"]);
  });

  it("uses the whole measure for a distributed seventh-chord arpeggio", () => {
    const notes = [
      note("c", pitchedTrack.id, 60, 0, 0.34),
      note("e-first", pitchedTrack.id, 64, 0.33, 0.67),
      note("g-first", pitchedTrack.id, 67, 0.66, 1),
      note("e-second", pitchedTrack.id, 64, 1, 1.34),
      note("g-second", pitchedTrack.id, 67, 1.33, 1.67),
      note("b", pitchedTrack.id, 71, 1.66, 2),
    ];

    expect(
      estimateChordSpans(notes, [pitchedTrack], 120, 0, 4, 4).map(
        ({ label, startBeat, beatLength }) => ({
          label,
          startBeat,
          beatLength,
        }),
      ),
    ).toEqual([{ label: "Cmaj7", startBeat: 1, beatLength: 4 }]);
  });

  it("preserves a two-beat change when both halves are arpeggiated", () => {
    const notes = [
      note("c", pitchedTrack.id, 60, 0, 0.34),
      note("e", pitchedTrack.id, 64, 0.33, 0.67),
      note("g", pitchedTrack.id, 67, 0.66, 1),
      note("f", pitchedTrack.id, 65, 1, 1.34),
      note("a", pitchedTrack.id, 69, 1.33, 1.67),
      note("high-c", pitchedTrack.id, 72, 1.66, 2),
    ];

    expect(
      estimateChordSpans(notes, [pitchedTrack], 120, 0, 4, 4).map(
        ({ label, startBeat, beatLength }) => ({
          label,
          startBeat,
          beatLength,
        }),
      ),
    ).toEqual([
      { label: "C", startBeat: 1, beatLength: 2 },
      { label: "F", startBeat: 3, beatLength: 2 },
    ]);
  });

  it("preserves a supported root change between chords with shared tones", () => {
    const notes = [
      ...[60, 64, 67].map((pitch) =>
        note(`c-${pitch}`, pitchedTrack.id, pitch, 0, 1),
      ),
      ...[57, 60, 64].map((pitch) =>
        note(`am-${pitch}`, pitchedTrack.id, pitch, 1, 2),
      ),
    ];

    expect(
      estimateChordSpans(notes, [pitchedTrack], 120, 0, 4, 4).map(
        ({ label, startBeat, beatLength }) => ({
          label,
          startBeat,
          beatLength,
        }),
      ),
    ).toEqual([
      { label: "C", startBeat: 1, beatLength: 2 },
      { label: "Am", startBeat: 3, beatLength: 2 },
    ]);
  });

  it("uses neighboring states to suppress one ambiguous chord window", () => {
    const middleWindow = [
      ...[72, 76, 79].map((pitch) =>
        note(`middle-c-${pitch}`, pitchedTrack.id, pitch, 0, 1),
      ),
      note("middle-d", pitchedTrack.id, 74, 0, 0.5),
    ];
    expect(
      estimateChordSpans(
        middleWindow,
        [pitchedTrack],
        120,
        0,
        2,
        4,
      ).map(({ label }) => label),
    ).toEqual(["Cadd9"]);

    const surroundingCChords = [0, 2].flatMap((startSec) =>
      [72, 76, 79].map((pitch) =>
        note(
          `c-${startSec}-${pitch}`,
          pitchedTrack.id,
          pitch,
          startSec,
          startSec + 1,
        ),
      ),
    );
    const sequence = [
      ...surroundingCChords,
      ...middleWindow.map((middleNote) => ({
        ...middleNote,
        id: `sequence-${middleNote.id}`,
        rawStartSec: middleNote.rawStartSec + 1,
        rawEndSec: middleNote.rawEndSec + 1,
        startSec: middleNote.startSec + 1,
        endSec: middleNote.endSec + 1,
      })),
    ];

    expect(
      estimateChordSpans(
        sequence,
        [pitchedTrack],
        120,
        0,
        2,
        4,
      ).map(({ label }) => label),
    ).toEqual(["C", "C", "C"]);
  });

  it("does not let a fast bass run replace the sustained harmony", () => {
    const harmony = [64, 67].map((pitch) =>
      note(`harmony-${pitch}`, pitchedTrack.id, pitch, 0, 1),
    );
    const bassRun = [
      [36, 0, 0.3],
      [38, 0.3, 0.4],
      [39, 0.4, 0.5],
      [40, 0.5, 0.6],
      [41, 0.6, 0.7],
      [43, 0.7, 0.8],
      [45, 0.8, 1],
    ].map(([pitch, startSec, endSec], index) =>
      note(`bass-${index}`, bassTrack.id, pitch, startSec, endSec),
    );

    expect(
      estimateChordSpans(
        [...harmony, ...bassRun],
        [pitchedTrack, bassTrack],
        120,
        0,
        4,
        4,
      ).map(({ label }) => label),
    ).toEqual(["C"]);
  });

  it("attenuates brief chromatic passing tones around sustained harmony", () => {
    const harmony = [60, 64, 67].map((pitch) =>
      note(`harmony-${pitch}`, pitchedTrack.id, pitch, 0, 1),
    );
    const passingTones = [61, 62, 63, 65, 66, 68, 69, 70, 71].map(
      (pitch, index) =>
        note(
          `passing-${pitch}`,
          pitchedTrack.id,
          pitch,
          index * 0.075,
          index * 0.075 + 0.25,
        ),
    );

    expect(
      estimateChordSpans(
        [...harmony, ...passingTones],
        [pitchedTrack],
        120,
        0,
        4,
        4,
      ).map(({ label }) => label),
    ).toEqual(["C"]);
  });

  it("uses sustained bass evidence to distinguish C6 from Am7", () => {
    const sharedTones = [60, 64, 67, 69].map((pitch) =>
      note(`shared-${pitch}`, pitchedTrack.id, pitch, 0, 1),
    );
    const cBass = [
      note("bass-c", bassTrack.id, 36, 0, 0.8),
      note("bass-a-passing", bassTrack.id, 45, 0.8, 1),
    ];
    const aBass = [
      note("bass-a", bassTrack.id, 45, 0, 0.8),
      note("bass-c-passing", bassTrack.id, 48, 0.8, 1),
    ];

    expect(
      estimateChordSpans(
        [...sharedTones, ...cBass],
        [pitchedTrack, bassTrack],
        120,
        0,
        4,
        4,
      ).map(({ label }) => label),
    ).toEqual(["C6"]);
    expect(
      estimateChordSpans(
        [...sharedTones, ...aBass],
        [pitchedTrack, bassTrack],
        120,
        0,
        4,
        4,
      ).map(({ label }) => label),
    ).toEqual(["Am7"]);
  });

  it("uses the sustained lowest note to distinguish C#m7 from E6", () => {
    const notes = [
      note("lowest-c-sharp", pitchedTrack.id, 49, 0, 2),
      note("e-low", pitchedTrack.id, 52, 0, 2),
      note("e-high", pitchedTrack.id, 64, 1, 2),
      note("g-sharp-low", pitchedTrack.id, 56, 0, 2),
      note("g-sharp-high", pitchedTrack.id, 68, 1, 2),
      note("b", pitchedTrack.id, 59, 0, 2),
    ];

    expect(
      estimateChordSpans(notes, [pitchedTrack], 120, 0, 4, 4).map(
        ({ label, beatLength }) => ({ label, beatLength }),
      ),
    ).toEqual([{ label: "C#m7", beatLength: 4 }]);
  });

  it("recognizes added-note harmony instead of collapsing it to a triad", () => {
    const notes = [60, 62, 64, 67].map((pitch) =>
      note(`cadd9-${pitch}`, pitchedTrack.id, pitch, 0, 1),
    );

    expect(
      estimateChordSpans(notes, [pitchedTrack], 120, 0, 4, 4).map(
        ({ label }) => label,
      ),
    ).toEqual(["Cadd9"]);
  });

  it.each([
    ["major", [60, 64, 67], "C"],
    ["minor", [60, 63, 67], "Cm"],
  ])(
    "treats a brief ninth over a sustained %s triad as a passing tone",
    (_quality, pitches, expected) => {
      const harmony = pitches.map((pitch) =>
        note(`harmony-${pitch}`, pitchedTrack.id, pitch, 0, 2),
      );
      const passingNinths = [
        note("passing-d-first", pitchedTrack.id, 62, 0.2, 0.55),
        note("passing-d-second", pitchedTrack.id, 74, 1.2, 1.55),
      ];

      expect(
        estimateChordSpans(
          [...harmony, ...passingNinths],
          [pitchedTrack],
          120,
          0,
          4,
          4,
        ).map(({ label }) => label),
      ).toEqual([expected]);
    },
  );

  it("keeps a distributed added ninth when all chord tones have equal support", () => {
    const notes = [
      note("c", pitchedTrack.id, 60, 0, 0.5),
      note("d", pitchedTrack.id, 62, 0.5, 1),
      note("e", pitchedTrack.id, 64, 1, 1.5),
      note("g", pitchedTrack.id, 67, 1.5, 2),
    ];

    expect(
      estimateChordSpans(notes, [pitchedTrack], 120, 0, 4, 4).map(
        ({ label, beatLength }) => ({ label, beatLength }),
      ),
    ).toEqual([{ label: "Cadd9", beatLength: 4 }]);
  });

  it("handles more notes than the JavaScript argument limit", () => {
    const pitches = [72, 76, 79];
    const notes = Array.from({ length: 130_000 }, (_, index) =>
      note(
        `large-${index}`,
        pitchedTrack.id,
        pitches[index % pitches.length],
        0,
        1,
      ),
    );

    expect(
      estimateChordSpans(notes, [pitchedTrack], 120, 0, 4, 4).map(
        ({ label }) => label,
      ),
    ).toEqual(["C"]);
  });

  it.each([
    ["Cmaj7", [60, 64, 67, 71]],
    ["C7", [60, 64, 67, 70]],
    ["Cm7", [60, 63, 67, 70]],
    ["Cm7b5", [60, 63, 66, 70]],
    ["C6", [60, 64, 67, 69]],
    ["Cm6", [60, 63, 67, 69]],
    ["Cadd9", [60, 62, 64, 67]],
    ["Cmadd9", [60, 62, 63, 67]],
    ["C7sus4", [60, 65, 67, 70]],
    ["C", [60, 64, 67]],
    ["Cm", [60, 63, 67]],
    ["Cdim", [60, 63, 66]],
    ["Caug", [60, 64, 68]],
    ["Csus2", [60, 62, 67]],
    ["Csus4", [60, 65, 67]],
  ])("recognizes %s without regression", (expected, pitches) => {
    const notes = pitches.map((pitch) =>
      note(`${expected}-${pitch}`, pitchedTrack.id, pitch, 0, 1),
    );

    expect(
      estimateChordSpans(notes, [pitchedTrack], 120, 0, 4, 4).map(
        ({ label }) => label,
      ),
    ).toEqual([expected]);
  });
});
