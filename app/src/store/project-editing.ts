import type { ProjectNote, QuantizeGrid } from "../types";

const MINIMUM_NOTE_DURATION_SEC = 0.01;

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

export function gridDurationSeconds(
  bpm: number,
  grid: QuantizeGrid,
): number {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new Error("BPMが不正です");
  }
  return ticksToSeconds(GRID_TICKS[grid], bpm);
}

export function snapTimeToGrid(
  timeSec: number,
  bpm: number,
  grid: QuantizeGrid,
  beatOffsetSec = 0,
): number {
  if (!Number.isFinite(timeSec) || !Number.isFinite(beatOffsetSec)) {
    throw new Error("グリッド位置が不正です");
  }
  const gridSec = gridDurationSeconds(bpm, grid);
  return Math.max(
    0,
    beatOffsetSec +
      Math.floor((timeSec - beatOffsetSec) / gridSec + 0.5) * gridSec,
  );
}

export function quantizeNotes(
  notes: ProjectNote[],
  bpm: number,
  grid: QuantizeGrid,
  beatOffsetSec = 0,
): ProjectNote[] {
  const gridSec = gridDurationSeconds(bpm, grid);
  const snap = (timeSec: number) =>
    snapTimeToGrid(timeSec, bpm, grid, beatOffsetSec);
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
  const earliestStart = notes.reduce(
    (earliest, note) => Math.min(earliest, note.startSec),
    Number.POSITIVE_INFINITY,
  );
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

export function moveSelectedNotesInTime(
  notes: ProjectNote[],
  selectedIds: ReadonlySet<string>,
  requestedOffsetSec: number,
  durationSec: number,
): ProjectNote[] {
  return moveSelectedNotesOnPianoRoll(
    notes,
    selectedIds,
    requestedOffsetSec,
    0,
    durationSec,
  );
}

export function moveSelectedNotesOnPianoRoll(
  notes: ProjectNote[],
  selectedIds: ReadonlySet<string>,
  requestedOffsetSec: number,
  requestedPitchOffset: number,
  durationSec: number,
): ProjectNote[] {
  if (!Number.isFinite(requestedOffsetSec)) {
    throw new Error("ノート移動量が不正です");
  }
  if (!Number.isInteger(requestedPitchOffset)) {
    throw new Error("音高移動量が不正です");
  }
  const selected = notes.filter((note) => selectedIds.has(note.id));
  if (
    selected.length === 0 ||
    (requestedOffsetSec === 0 && requestedPitchOffset === 0)
  ) {
    return notes;
  }
  const earliestStart = Math.min(...selected.map((note) => note.startSec));
  const latestEnd = Math.max(...selected.map((note) => note.endSec));
  const lowestPitch = Math.min(...selected.map((note) => note.pitch));
  const highestPitch = Math.max(...selected.map((note) => note.pitch));
  const lowerBound = -earliestStart;
  const upperBound = Math.max(lowerBound, durationSec - latestEnd);
  const offsetSec = Math.min(
    upperBound,
    Math.max(lowerBound, requestedOffsetSec),
  );
  const pitchOffset = Math.min(
    127 - highestPitch,
    Math.max(-lowestPitch, requestedPitchOffset),
  );
  if (offsetSec === 0 && pitchOffset === 0) {
    return notes;
  }
  return notes
    .map((note) =>
      selectedIds.has(note.id)
        ? {
            ...note,
            pitch: note.pitch + pitchOffset,
            startSec: note.startSec + offsetSec,
            endSec: note.endSec + offsetSec,
          }
        : note,
    )
    .sort(
      (left, right) =>
        left.startSec - right.startSec ||
        left.pitch - right.pitch ||
        left.id.localeCompare(right.id),
    );
}

export function resizeNoteEnd(
  notes: ProjectNote[],
  noteId: string,
  requestedEndSec: number,
  durationSec: number,
): ProjectNote[] {
  if (!Number.isFinite(requestedEndSec)) {
    throw new Error("ノート終了位置が不正です");
  }
  const current = notes.find((note) => note.id === noteId);
  if (current === undefined) {
    return notes;
  }
  const endSec = Math.min(
    durationSec,
    Math.max(current.startSec + MINIMUM_NOTE_DURATION_SEC, requestedEndSec),
  );
  if (endSec === current.endSec) {
    return notes;
  }
  return notes.map((note) =>
    note.id === noteId
      ? {
          ...note,
          endSec,
        }
      : note,
  );
}

export function resizeNoteStart(
  notes: ProjectNote[],
  noteId: string,
  requestedStartSec: number,
): ProjectNote[] {
  if (!Number.isFinite(requestedStartSec)) {
    throw new Error("ノート開始位置が不正です");
  }
  const current = notes.find((note) => note.id === noteId);
  if (current === undefined) {
    return notes;
  }
  const startSec = Math.max(
    0,
    Math.min(current.endSec - MINIMUM_NOTE_DURATION_SEC, requestedStartSec),
  );
  if (startSec === current.startSec) {
    return notes;
  }
  return notes.map((note) =>
    note.id === noteId
      ? {
          ...note,
          startSec,
        }
      : note,
  );
}

export function setSelectedNoteDuration(
  notes: ProjectNote[],
  selectedIds: ReadonlySet<string>,
  requestedDurationSec: number,
  projectDurationSec: number,
): ProjectNote[] {
  if (!Number.isFinite(requestedDurationSec) || requestedDurationSec <= 0) {
    throw new Error("音価が不正です");
  }
  let changed = false;
  const result = notes.map((note) => {
    if (!selectedIds.has(note.id)) {
      return note;
    }
    const endSec = Math.min(
      projectDurationSec,
      Math.max(note.startSec + MINIMUM_NOTE_DURATION_SEC, note.startSec + requestedDurationSec),
    );
    if (endSec === note.endSec) {
      return note;
    }
    changed = true;
    return { ...note, endSec };
  });
  return changed ? result : notes;
}

export function splitSelectedNotes(
  notes: ProjectNote[],
  selectedIds: ReadonlySet<string>,
  splitSec: number,
  createId: () => string,
): { notes: ProjectNote[]; selectedIds: Set<string> } {
  if (!Number.isFinite(splitSec)) {
    throw new Error("分割位置が不正です");
  }
  const result: ProjectNote[] = [];
  const resultSelection = new Set<string>();
  let changed = false;
  for (const note of notes) {
    if (
      !selectedIds.has(note.id) ||
      splitSec <= note.startSec + MINIMUM_NOTE_DURATION_SEC ||
      splitSec >= note.endSec - MINIMUM_NOTE_DURATION_SEC
    ) {
      result.push(note);
      if (selectedIds.has(note.id)) {
        resultSelection.add(note.id);
      }
      continue;
    }
    changed = true;
    const rightId = createId();
    result.push(
      { ...note, endSec: splitSec },
      {
        ...note,
        id: rightId,
        rawStartSec: splitSec,
        startSec: splitSec,
      },
    );
    resultSelection.add(note.id);
    resultSelection.add(rightId);
  }
  if (!changed) {
    return { notes, selectedIds: new Set(selectedIds) };
  }
  result.sort(
    (left, right) =>
      left.startSec - right.startSec ||
      left.pitch - right.pitch ||
      left.id.localeCompare(right.id),
  );
  return { notes: result, selectedIds: resultSelection };
}

export function joinSelectedNotes(
  notes: ProjectNote[],
  selectedIds: ReadonlySet<string>,
  maximumGapSec: number,
): { notes: ProjectNote[]; selectedIds: Set<string> } {
  if (!Number.isFinite(maximumGapSec) || maximumGapSec < 0) {
    throw new Error("結合可能な間隔が不正です");
  }
  const groups = new Map<string, ProjectNote[]>();
  for (const note of notes) {
    if (!selectedIds.has(note.id)) {
      continue;
    }
    const key = `${note.trackId}:${note.pitch}`;
    const group = groups.get(key) ?? [];
    group.push(note);
    groups.set(key, group);
  }

  const replacements = new Map<string, ProjectNote>();
  const removedIds = new Set<string>();
  const resultSelection = new Set<string>();
  let changed = false;
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (left, right) => left.startSec - right.startSec || left.endSec - right.endSec,
    );
    let run: ProjectNote[] = [];
    const finishRun = () => {
      if (run.length === 0) {
        return;
      }
      const first = run[0];
      if (run.length === 1) {
        resultSelection.add(first.id);
        run = [];
        return;
      }
      changed = true;
      const merged: ProjectNote = {
        ...first,
        rawStartSec: Math.min(...run.map((note) => note.rawStartSec)),
        rawEndSec: Math.max(...run.map((note) => note.rawEndSec)),
        startSec: Math.min(...run.map((note) => note.startSec)),
        endSec: Math.max(...run.map((note) => note.endSec)),
        velocity: Math.max(...run.map((note) => note.velocity)),
      };
      replacements.set(first.id, merged);
      for (const note of run.slice(1)) {
        removedIds.add(note.id);
      }
      resultSelection.add(first.id);
      run = [];
    };

    for (const note of ordered) {
      const previous = run.at(-1);
      if (previous !== undefined && note.startSec - previous.endSec > maximumGapSec) {
        finishRun();
      }
      run.push(note);
    }
    finishRun();
  }
  if (!changed) {
    return { notes, selectedIds: new Set(selectedIds) };
  }
  const result = notes
    .filter((note) => !removedIds.has(note.id))
    .map((note) => replacements.get(note.id) ?? note)
    .sort(
      (left, right) =>
        left.startSec - right.startSec ||
        left.pitch - right.pitch ||
        left.id.localeCompare(right.id),
    );
  return { notes: result, selectedIds: resultSelection };
}

export function deleteNotes(
  notes: ProjectNote[],
  selectedIds: ReadonlySet<string>,
): ProjectNote[] {
  if (selectedIds.size === 0) {
    return notes;
  }
  return notes.filter((note) => !selectedIds.has(note.id));
}

export function resolveNoteOverlaps(notes: ProjectNote[]): ProjectNote[] {
  const notesByKey = new Map<string, ProjectNote[]>();
  for (const note of notes) {
    const key = `${note.trackId}:${note.pitch}`;
    const group = notesByKey.get(key);
    if (group === undefined) {
      notesByKey.set(key, [note]);
    } else {
      group.push(note);
    }
  }

  const resolved: ProjectNote[] = [];
  for (const group of notesByKey.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        left.startSec - right.startSec ||
        right.endSec - left.endSec ||
        left.id.localeCompare(right.id),
    );
    const normalized: ProjectNote[] = [];
    for (const note of ordered) {
      const previous = normalized.at(-1);
      if (previous === undefined) {
        normalized.push(note);
        continue;
      }

      const onsetGapSec = note.startSec - previous.startSec;
      if (onsetGapSec < MINIMUM_NOTE_DURATION_SEC) {
        if (note.endSec > previous.endSec) {
          normalized[normalized.length - 1] = note;
        }
        continue;
      }
      if (previous.endSec > note.startSec) {
        normalized[normalized.length - 1] = {
          ...previous,
          endSec: note.startSec,
        };
      }
      normalized.push(note);
    }
    resolved.push(...normalized);
  }

  return resolved.sort(
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
