import { describe, expect, it } from "vitest";
import type { ProjectNote } from "../types";
import {
  deleteNotes,
  gridDurationSeconds,
  moveSelectedNotesInTime,
  moveSelectedNotesOnPianoRoll,
  quantizeNotes,
  reassignNotes,
  resolveNoteOverlaps,
  resizeNoteEnd,
  resizeNoteStart,
  secondsToTicks,
  setSelectedNoteDuration,
  shiftNotes,
  snapTimeToGrid,
  splitSelectedNotes,
  joinSelectedNotes,
} from "./project-editing";

function note(
  id: string,
  trackId: string,
  startSec: number,
  endSec: number,
): ProjectNote {
  return {
    id,
    sourceInstrumentId: "acoustic_piano",
    trackId,
    pitch: 60,
    rawStartSec: startSec,
    rawEndSec: endSec,
    startSec,
    endSec,
    velocity: 100,
  };
}

describe("project editing", () => {
  it("snaps edit positions to the selected grid and beat phase", () => {
    expect(gridDurationSeconds(120, "1/16")).toBeCloseTo(0.125);
    expect(snapTimeToGrid(0.39, 120, "1/16", 0.05)).toBeCloseTo(0.425);
  });

  it("quantizes both endpoints and enforces one grid of duration", () => {
    const [result] = quantizeNotes([note("n1", "a", 0.13, 0.14)], 120, "1/16");

    expect(secondsToTicks(result.startSec, 120)).toBe(120);
    expect(secondsToTicks(result.endSec, 120)).toBe(240);
    expect(result.rawStartSec).toBe(0.13);
  });

  it("lets the longest moving note overwrite a duplicate destination", () => {
    const existing = note("existing", "target", 1, 1.4);
    const short = note("short", "source", 1, 1.5);
    const long = note("long", "source", 1, 2);

    const result = reassignNotes(
      [existing, short, long],
      new Set(["short", "long"]),
      "target",
      120,
    );

    expect(result.notes).toEqual([{ ...long, trackId: "target" }]);
    expect([...result.selectedIds]).toEqual(["long"]);
  });

  it("quantizes against the analyzed beat phase instead of time zero", () => {
    const [result] = quantizeNotes(
      [note("n1", "a", 0.34, 0.57)],
      120,
      "1/8",
      0.1,
    );

    expect(result.startSec).toBeCloseTo(0.35);
    expect(result.endSec).toBeCloseTo(0.6);
    expect(result.rawStartSec).toBe(0.34);
  });

  it("shifts every edited endpoint equally and preserves raw detection times", () => {
    const result = shiftNotes(
      [note("n1", "a", 0.4, 0.7), note("n2", "a", 1, 1.4)],
      -0.15,
    );

    expect(result.map((item) => item.startSec)).toEqual([0.25, 0.85]);
    expect(result[0].endSec).toBeCloseTo(0.55);
    expect(result[1].endSec).toBeCloseTo(1.25);
    expect(result.map((item) => item.rawStartSec)).toEqual([0.4, 1]);
  });

  it("limits a negative global shift at the start of the audio", () => {
    const result = shiftNotes([note("n1", "a", 0.1, 0.4)], -0.5);

    expect(result[0].startSec).toBe(0);
    expect(result[0].endSec).toBeCloseTo(0.3);
  });

  it("moves only selected notes and clamps them inside the audio", () => {
    const result = moveSelectedNotesInTime(
      [
        note("selected", "a", 0.2, 0.5),
        note("other", "a", 1, 1.5),
      ],
      new Set(["selected"]),
      -1,
      10,
    );

    expect(result.find(({ id }) => id === "selected")).toMatchObject({
      startSec: 0,
      endSec: 0.3,
    });
    expect(result.find(({ id }) => id === "other")).toMatchObject({
      startSec: 1,
      endSec: 1.5,
    });
  });

  it("moves selected notes in time and pitch within the MIDI range", () => {
    const result = moveSelectedNotesOnPianoRoll(
      [
        note("selected", "a", 0.2, 0.5),
        { ...note("other-selected", "a", 1, 1.5), pitch: 100 },
        note("other", "a", 2, 2.5),
      ],
      new Set(["selected", "other-selected"]),
      -1,
      40,
      10,
    );

    expect(result.find(({ id }) => id === "selected")).toMatchObject({
      pitch: 87,
      startSec: 0,
      endSec: 0.3,
    });
    expect(result.find(({ id }) => id === "other-selected")).toMatchObject({
      pitch: 127,
      startSec: 0.8,
      endSec: 1.3,
    });
    expect(result.find(({ id }) => id === "other")).toMatchObject({
      pitch: 60,
      startSec: 2,
      endSec: 2.5,
    });
  });

  it("resizes a note with a minimum duration and deletes selected notes", () => {
    const notes = [
      note("selected", "a", 1, 2),
      note("other", "a", 3, 4),
    ];
    const resized = resizeNoteEnd(notes, "selected", 0, 10);

    expect(resized[0].endSec).toBeCloseTo(1.01);
    expect(deleteNotes(resized, new Set(["selected"]))).toEqual([notes[1]]);
  });

  it("resizes the beginning of a note without changing its end", () => {
    const notes = [note("selected", "a", 1, 2)];

    expect(resizeNoteStart(notes, "selected", 1.5)[0]).toMatchObject({
      startSec: 1.5,
      endSec: 2,
    });
    expect(resizeNoteStart(notes, "selected", 3)[0].startSec).toBeCloseTo(1.99);
  });

  it("sets the duration of selected notes and limits them to the project", () => {
    const notes = [note("selected", "a", 1, 2), note("other", "a", 4, 4.5)];
    const result = setSelectedNoteDuration(
      notes,
      new Set(["selected", "other"]),
      2,
      5,
    );

    expect(result.map(({ endSec }) => endSec)).toEqual([3, 5]);
  });

  it("splits selected notes that cross the requested position", () => {
    let sequence = 0;
    const result = splitSelectedNotes(
      [note("selected", "a", 1, 3), note("outside", "a", 4, 5)],
      new Set(["selected", "outside"]),
      2,
      () => `new-${++sequence}`,
    );

    expect(result.notes).toHaveLength(3);
    expect(result.notes.slice(0, 2)).toMatchObject([
      { id: "selected", startSec: 1, endSec: 2 },
      { id: "new-1", startSec: 2, endSec: 3 },
    ]);
    expect(result.selectedIds).toEqual(new Set(["selected", "new-1", "outside"]));
  });

  it("joins adjacent selected notes only when track and pitch match", () => {
    const first = note("first", "a", 1, 2);
    const second = note("second", "a", 2.1, 3);
    const otherPitch = { ...note("other-pitch", "a", 2, 3), pitch: 62 };
    const result = joinSelectedNotes(
      [first, second, otherPitch],
      new Set(["first", "second", "other-pitch"]),
      0.125,
    );

    expect(result.notes).toHaveLength(2);
    expect(result.notes.find(({ id }) => id === "first")).toMatchObject({
      startSec: 1,
      endSec: 3,
    });
    expect(result.notes).toContainEqual(otherPitch);
    expect(result.selectedIds).toEqual(new Set(["first", "other-pitch"]));
  });

  it("ends a note when the same track and pitch is played again", () => {
    const sustained = note("sustained", "piano", 0, 10);
    const retriggered = note("retriggered", "piano", 2, 3);

    const result = resolveNoteOverlaps([retriggered, sustained]);

    expect(result).toEqual([
      {
        ...sustained,
        endSec: 2,
      },
      retriggered,
    ]);
    expect(result[0].rawEndSec).toBe(10);
  });

  it("keeps the longest duplicate onset for one track and pitch", () => {
    const short = note("short", "piano", 1, 1.5);
    const long = note("long", "piano", 1.005, 2);

    expect(resolveNoteOverlaps([short, long])).toEqual([long]);
  });

  it("removes same-pitch duplicates introduced by score quantization", () => {
    const first = note("first", "piano", 0.01, 0.02);
    const second = note("second", "piano", 0.03, 0.04);

    const result = resolveNoteOverlaps(
      quantizeNotes([first, second], 120, "1/8"),
    );

    expect(result).toEqual([
      {
        ...first,
        startSec: 0,
        endSec: 0.25,
      },
    ]);
  });

  it("does not trim overlapping notes on different pitches or tracks", () => {
    const first = note("first", "piano", 0, 10);
    const otherPitch = { ...note("pitch", "piano", 2, 3), pitch: 64 };
    const otherTrack = note("track", "guitar", 2, 3);

    expect(resolveNoteOverlaps([first, otherPitch, otherTrack])).toEqual([
      first,
      otherTrack,
      otherPitch,
    ]);
  });
});
