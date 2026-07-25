import { describe, expect, it } from "vitest";
import type { ProjectNote } from "../types";
import {
  quantizeNotes,
  reassignNotes,
  secondsToTicks,
  shiftNotes,
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
});
