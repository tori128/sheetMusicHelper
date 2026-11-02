import { describe, expect, it } from "vitest";
import type { ProjectNote, ProjectTrack } from "../types";
import { estimateChordSpans } from "./chord-estimation";

const PITCH_CLASS_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

const track: ProjectTrack = {
  id: "benchmark",
  displayName: "Benchmark",
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

interface BenchmarkCase {
  name: string;
  category: "passing" | "added-ninth" | "seventh";
  expected: string;
  notes: ProjectNote[];
}

function note(
  id: string,
  pitch: number,
  startSec: number,
  endSec: number,
): ProjectNote {
  return {
    id,
    sourceInstrumentId: track.instrumentId,
    trackId: track.id,
    pitch,
    rawStartSec: startSec,
    rawEndSec: endSec,
    startSec,
    endSec,
    velocity: 100,
  };
}

function sustainedNotes(
  rootPitch: number,
  intervals: readonly number[],
  prefix: string,
): ProjectNote[] {
  return intervals.map((interval) =>
    note(`${prefix}-${interval}`, rootPitch + interval, 0, 2),
  );
}

function benchmarkCases(): BenchmarkCase[] {
  const cases: BenchmarkCase[] = [];
  for (let root = 0; root < 12; root += 1) {
    const rootPitch = 48 + root;
    const label = PITCH_CLASS_NAMES[root];
    for (const [quality, intervals, suffix] of [
      ["major", [0, 4, 7], ""],
      ["minor", [0, 3, 7], "m"],
    ] as const) {
      cases.push({
        name: `${label} ${quality} with passing ninth`,
        category: "passing",
        expected: `${label}${suffix}`,
        notes: [
          ...sustainedNotes(rootPitch, intervals, `${label}-${quality}`),
          note(`${label}-${quality}-ninth-1`, rootPitch + 2, 0.2, 0.55),
          note(`${label}-${quality}-ninth-2`, rootPitch + 14, 1.2, 1.55),
        ],
      });
    }
    for (const [quality, intervals, suffix] of [
      ["major", [0, 2, 4, 7], "add9"],
      ["minor", [0, 2, 3, 7], "madd9"],
    ] as const) {
      cases.push({
        name: `${label} ${quality} sustained added ninth`,
        category: "added-ninth",
        expected: `${label}${suffix}`,
        notes: sustainedNotes(
          rootPitch,
          intervals,
          `${label}-${quality}-add9`,
        ),
      });
    }
    cases.push({
      name: `${label} distributed added ninth`,
      category: "added-ninth",
      expected: `${label}add9`,
      notes: [0, 2, 4, 7].map((interval, index) =>
        note(
          `${label}-distributed-${interval}`,
          rootPitch + interval,
          index * 0.5,
          (index + 1) * 0.5,
        ),
      ),
    });
    for (const [suffix, intervals] of [
      ["maj7", [0, 4, 7, 11]],
      ["7", [0, 4, 7, 10]],
      ["m7", [0, 3, 7, 10]],
    ] as const) {
      cases.push({
        name: `${label}${suffix} sustained`,
        category: "seventh",
        expected: `${label}${suffix}`,
        notes: sustainedNotes(
          rootPitch,
          intervals,
          `${label}-${suffix}`,
        ),
      });
    }
  }
  return cases;
}

describe("chord estimation benchmark", () => {
  it("keeps added-ninth precision and recall across all pitch classes", () => {
    const cases = benchmarkCases();
    const results = cases.map((benchmark) => ({
      ...benchmark,
      actual:
        estimateChordSpans(
          benchmark.notes,
          [track],
          120,
          0,
          4,
          4,
        )[0]?.label ?? null,
    }));
    const failures = results.filter(
      (result) => result.actual !== result.expected,
    );
    const passingCases = results.filter(
      (result) => result.category === "passing",
    );
    const addedNinthCases = results.filter(
      (result) => result.category === "added-ninth",
    );
    const falseAddedNinths = passingCases.filter((result) =>
      result.actual?.includes("add9"),
    );
    const missedAddedNinths = addedNinthCases.filter(
      (result) => result.actual !== result.expected,
    );

    expect({
      cases: cases.length,
      correct: results.length - failures.length,
      accuracy: (results.length - failures.length) / results.length,
      passingToneCases: passingCases.length,
      falseAddedNinths: falseAddedNinths.length,
      addedNinthCases: addedNinthCases.length,
      missedAddedNinths: missedAddedNinths.length,
      failures: failures.map(({ name, expected, actual }) => ({
        name,
        expected,
        actual,
      })),
    }).toEqual({
      cases: 96,
      correct: 96,
      accuracy: 1,
      passingToneCases: 24,
      falseAddedNinths: 0,
      addedNinthCases: 36,
      missedAddedNinths: 0,
      failures: [],
    });
  });
});
