import { describe, expect, it } from "vitest";
import type { ProjectNote } from "../types";
import {
  buildBeatGridLines,
  buildNoteTimeIndex,
  findVisibleNotes,
  normalizedRectangle,
  noteAtPoint,
  noteRectangle,
  pianoRollWheelAction,
  playheadFollowScrollLeft,
  notesIntersectingRectangle,
  timeToViewportX,
  zoomedScrollOffset,
  zoomFromWheel,
  type RollViewport,
} from "./piano-roll-math";

function note(
  id: string,
  startSec: number,
  endSec: number,
  pitch: number,
): ProjectNote {
  return {
    id,
    sourceInstrumentId: "acoustic_piano",
    trackId: "track",
    pitch,
    rawStartSec: startSec,
    rawEndSec: endSec,
    startSec,
    endSec,
    velocity: 100,
  };
}

const viewport: RollViewport = {
  scrollLeft: 0,
  scrollTop: 0,
  width: 800,
  height: 500,
  pixelsPerSecond: 100,
  rowHeight: 10,
  headerHeight: 24,
};

describe("piano roll time index", () => {
  it("maps wheel modifiers to horizontal scrolling and axis zoom", () => {
    expect(pianoRollWheelAction(false, false)).toBe("horizontal-scroll");
    expect(pianoRollWheelAction(true, false)).toBe("horizontal-zoom");
    expect(pianoRollWheelAction(false, true)).toBe("vertical-zoom");
    expect(pianoRollWheelAction(true, true)).toBe("vertical-zoom");
  });

  it("zooms in and out from wheel direction within axis limits", () => {
    expect(zoomFromWheel(1, -100, 0.25, 4)).toBeCloseTo(1.15);
    expect(zoomFromWheel(1, 100, 0.25, 4)).toBeCloseTo(1 / 1.15);
    expect(zoomFromWheel(4, -100, 0.25, 4)).toBe(4);
    expect(zoomFromWheel(0.25, 100, 0.25, 4)).toBe(0.25);
  });

  it("keeps the content below the mouse fixed while zooming", () => {
    expect(zoomedScrollOffset(500, 200, 100, 200)).toBe(1200);
    expect(zoomedScrollOffset(500, 200, 100, 50)).toBe(150);
  });

  it("builds measure and beat lines from BPM and analyzed beat phase", () => {
    expect(buildBeatGridLines(0, 2.1, 120, 0.1, 4, 4)).toEqual([
      {
        timeSec: 0.1,
        measureNumber: 1,
        beatInMeasure: 1,
        isMeasureStart: true,
      },
      {
        timeSec: 0.6,
        measureNumber: 1,
        beatInMeasure: 2,
        isMeasureStart: false,
      },
      {
        timeSec: 1.1,
        measureNumber: 1,
        beatInMeasure: 3,
        isMeasureStart: false,
      },
      {
        timeSec: 1.6,
        measureNumber: 1,
        beatInMeasure: 4,
        isMeasureStart: false,
      },
      {
        timeSec: 2.1,
        measureNumber: 2,
        beatInMeasure: 1,
        isMeasureStart: true,
      },
    ]);
  });

  it("uses the time-signature denominator for beat spacing", () => {
    const lines = buildBeatGridLines(0, 1.6, 120, 0.1, 6, 8);

    expect(lines.slice(0, 3).map((line) => line.timeSec)).toEqual([
      0.1, 0.35, 0.6,
    ]);
    expect(lines.at(-1)).toMatchObject({
      timeSec: 1.6,
      measureNumber: 2,
      beatInMeasure: 1,
      isMeasureStart: true,
    });
  });

  it("keeps a selected note aligned to repeating measure starts", () => {
    const measureStarts = buildBeatGridLines(0, 5.25, 120, 1.25, 4, 4)
      .filter((line) => line.isMeasureStart)
      .map((line) => line.timeSec);

    expect(measureStarts).toEqual([1.25, 3.25, 5.25]);
  });

  it("recalculates beat spacing when BPM changes", () => {
    const at120 = buildBeatGridLines(0, 1, 120, 0, 4, 4);
    const at100 = buildBeatGridLines(0, 1.2, 100, 0, 4, 4);

    expect(at120[1].timeSec).toBe(0.5);
    expect(at100[1].timeSec).toBe(0.6);
  });

  it("finds long overlapping notes that start before the viewport", () => {
    const index = buildNoteTimeIndex([
      note("long", 0, 20, 60),
      note("short", 2, 3, 61),
      note("visible", 10, 11, 62),
      note("later", 30, 31, 63),
    ]);

    expect(findVisibleNotes(index, 9, 12).map((item) => item.id)).toEqual([
      "long",
      "visible",
    ]);
  });

  it("maps MIDI pitch and time to viewport coordinates", () => {
    const rectangle = noteRectangle(note("n", 2, 2.5, 127), viewport);

    expect(rectangle).toEqual({
      x: 200,
      y: 24,
      width: 50,
      height: 9,
    });
  });

  it("maps playback time to the shared horizontal viewport", () => {
    expect(timeToViewportX(2.5, { ...viewport, scrollLeft: 50 })).toBe(200);
  });

  it("scrolls playback ahead when the playhead leaves the safe viewport", () => {
    expect(playheadFollowScrollLeft(10, 0, 800, 100, 5000)).toBe(800);
    expect(playheadFollowScrollLeft(4, 0, 800, 100, 5000)).toBeNull();
  });

  it("clamps playback following at both ends of the roll", () => {
    expect(playheadFollowScrollLeft(0, 1000, 800, 100, 5000)).toBe(0);
    expect(playheadFollowScrollLeft(60, 3000, 800, 100, 5000)).toBe(4200);
  });

  it("maps drum pitches against the dedicated lane range", () => {
    const rectangle = noteRectangle(note("kick", 0, 0.1, 36), {
      ...viewport,
      maxPitch: 87,
    });

    expect(rectangle.y).toBe(24 + (87 - 36) * 10);
  });

  it("keeps short drum notes wide enough to select at every horizontal zoom", () => {
    const shortDrumNote = note("kick", 1, 1.005, 36);

    expect(
      noteRectangle(shortDrumNote, { ...viewport, pixelsPerSecond: 22.5 }, 14)
        .width,
    ).toBe(14);
    expect(
      noteRectangle(shortDrumNote, { ...viewport, pixelsPerSecond: 360 }, 14)
        .width,
    ).toBe(14);
  });

  it("selects the visible extension of a short drum note", () => {
    const index = buildNoteTimeIndex([note("kick", 1, 1.005, 36)]);
    const selection = normalizedRectangle(112, 936, 113, 938);

    expect(
      notesIntersectingRectangle(index, selection, viewport, 14).map(
        (item) => item.id,
      ),
    ).toEqual(["kick"]);
  });

  it("hits a short drum note across its minimum displayed width", () => {
    const index = buildNoteTimeIndex([note("kick", 1, 1.005, 36)]);

    expect(noteAtPoint(index, { x: 112, y: 936 }, viewport, 14)?.id).toBe(
      "kick",
    );
    expect(noteAtPoint(index, { x: 115, y: 936 }, viewport, 14)).toBeUndefined();
  });

  it("selects every note intersecting a normalized drag rectangle", () => {
    const index = buildNoteTimeIndex([
      note("inside", 1, 2, 120),
      note("outside-time", 5, 6, 120),
      note("outside-pitch", 1, 2, 80),
    ]);
    const selection = normalizedRectangle(205, 100, 95, 20);

    expect(
      notesIntersectingRectangle(index, selection, viewport).map(
        (item) => item.id,
      ),
    ).toEqual(["inside"]);
  });

  it("keeps visible-range results bounded for 100,000 notes", () => {
    const manyNotes = Array.from({ length: 100_000 }, (_, index) =>
      note(`note-${index}`, index / 100, index / 100 + 0.25, index % 128),
    );
    const index = buildNoteTimeIndex(manyNotes);

    const visible = findVisibleNotes(index, 500, 501);

    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(200);
    expect(visible.every((candidate) => candidate.endSec >= 500)).toBe(true);
  });
});
