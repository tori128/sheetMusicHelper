import type { ProjectNote, QuantizeGrid } from "../types";

export const GRID_TICKS: Record<QuantizeGrid, number> = {
  "1/4": 480,
  "1/8": 240,
  "1/16": 120,
  "1/32": 60,
  "1/8T": 160,
  "1/16T": 80,
};

export function secondsToTicks(seconds: number, bpm: number): number {
  return Math.floor((seconds * bpm * 480) / 60 + 0.5);
}

export function ticksToSeconds(ticks: number, bpm: number): number {
  return (ticks * 60) / (bpm * 480);
}

export function quantizeNotes(
  notes: ProjectNote[],
  bpm: number,
  grid: QuantizeGrid,
  beatOffsetSec = 0,
): ProjectNote[] {
  const gridTicks = GRID_TICKS[grid];
  const gridSec = ticksToSeconds(gridTicks, bpm);
  const snap = (timeSec: number) =>
    Math.max(
      0,
      beatOffsetSec +
        Math.floor((timeSec - beatOffsetSec) / gridSec + 0.5) * gridSec,
    );
  return notes.map((note) => {
    const startSec = snap(note.startSec);
    const endSec = Math.max(snap(note.endSec), startSec + gridSec);
    return {
      ...note,
      startSec,
      endSec,
    };
  });
}

export function shiftNotes(
  notes: ProjectNote[],
  requestedOffsetSec: number,
): ProjectNote[] {
  if (!Number.isFinite(requestedOffsetSec)) {
    throw new Error("ノート位置補正値が不正です");
  }
  if (notes.length === 0 || requestedOffsetSec === 0) {
    return notes;
  }
  const earliestStart = Math.min(...notes.map((note) => note.startSec));
  const offsetSec = Math.max(requestedOffsetSec, -earliestStart);
  return notes
    .map((note) => ({
      ...note,
      startSec: note.startSec + offsetSec,
      endSec: note.endSec + offsetSec,
    }))
    .sort(
      (left, right) =>
        left.startSec - right.startSec ||
        left.pitch - right.pitch ||
        left.id.localeCompare(right.id),
    );
}

export function reassignNotes(
  notes: ProjectNote[],
  selectedIds: ReadonlySet<string>,
  targetTrackId: string,
  bpm: number,
): { notes: ProjectNote[]; selectedIds: Set<string> } {
  const moving = notes.filter((note) => selectedIds.has(note.id));
  if (moving.length === 0) {
    return { notes, selectedIds: new Set() };
  }
  const winners = new Map<string, ProjectNote>();
  for (const note of moving) {
    const moved = { ...note, trackId: targetTrackId };
    const key = `${targetTrackId}:${moved.pitch}:${secondsToTicks(
      moved.startSec,
      bpm,
    )}`;
    const current = winners.get(key);
    if (
      current === undefined ||
      secondsToTicks(moved.endSec, bpm) >
        secondsToTicks(current.endSec, bpm)
    ) {
      winners.set(key, moved);
    }
  }
  const winnerKeys = new Set(winners.keys());
  const remaining = notes.filter((note) => {
    if (selectedIds.has(note.id)) {
      return false;
    }
    const key = `${note.trackId}:${note.pitch}:${secondsToTicks(
      note.startSec,
      bpm,
    )}`;
    return !winnerKeys.has(key);
  });
  const result = [...remaining, ...winners.values()].sort(
    (left, right) =>
      left.startSec - right.startSec ||
      left.pitch - right.pitch ||
      left.id.localeCompare(right.id),
  );
  return {
    notes: result,
    selectedIds: new Set([...winners.values()].map((note) => note.id)),
  };
}
