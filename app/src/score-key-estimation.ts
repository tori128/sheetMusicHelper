import type { ProjectNote, ProjectTrack } from "./types";

const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29,
  2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34,
  3.17,
];
const MAJOR_FIFTHS = [0, 7, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
const MINOR_FIFTHS = [-3, 4, -1, 6, 1, -4, 3, -2, 5, 0, -5, 2];

export interface EstimatedKeySignature {
  keyFifths: number;
  keyMode: "major" | "minor";
  confidence: number;
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
  const leftMagnitude = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightMagnitude = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
  return leftMagnitude > 0 && rightMagnitude > 0
    ? dot / (leftMagnitude * rightMagnitude)
    : 0;
}

function rotatedProfile(profile: readonly number[], tonic: number): number[] {
  return Array.from({ length: 12 }, (_, pitchClass) =>
    profile[(pitchClass - tonic + 12) % 12],
  );
}

export function estimateKeySignature(
  notes: readonly ProjectNote[],
  tracks: readonly ProjectTrack[],
): EstimatedKeySignature | null {
  const pitchedTrackIds = new Set(
    tracks.filter((track) => track.kind === "pitched").map((track) => track.id),
  );
  const histogram = Array<number>(12).fill(0);
  for (const note of notes) {
    if (!pitchedTrackIds.has(note.trackId)) {
      continue;
    }
    const duration = Math.min(2, Math.max(0.01, note.endSec - note.startSec));
    histogram[note.pitch % 12] += duration * Math.max(0.1, note.velocity / 127);
  }
  if (histogram.every((value) => value === 0)) {
    return null;
  }

  const candidates: Array<EstimatedKeySignature & { score: number }> = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    candidates.push({
      keyFifths: MAJOR_FIFTHS[tonic],
      keyMode: "major",
      score: cosineSimilarity(histogram, rotatedProfile(MAJOR_PROFILE, tonic)),
      confidence: 0,
    });
    candidates.push({
      keyFifths: MINOR_FIFTHS[tonic],
      keyMode: "minor",
      score: cosineSimilarity(histogram, rotatedProfile(MINOR_PROFILE, tonic)),
      confidence: 0,
    });
  }
  candidates.sort(
    (left, right) => right.score - left.score || Math.abs(left.keyFifths) - Math.abs(right.keyFifths),
  );
  const best = candidates[0];
  const second = candidates[1];
  return {
    keyFifths: best.keyFifths,
    keyMode: best.keyMode,
    confidence: Math.max(0, best.score - second.score),
  };
}
