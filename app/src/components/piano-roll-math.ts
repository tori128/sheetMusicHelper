import type { ProjectNote } from "../types";

export interface NoteTimeIndex {
  notes: ProjectNote[];
  prefixMaxEnd: number[];
}

export interface RollViewport {
  scrollLeft: number;
  scrollTop: number;
  width: number;
  height: number;
  pixelsPerSecond: number;
  rowHeight: number;
  headerHeight: number;
  maxPitch?: number;
  pitchRows?: readonly number[];
}

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BeatGridLine {
  timeSec: number;
  measureNumber: number;
  beatInMeasure: number;
  isMeasureStart: boolean;
}

export type PianoRollWheelAction =
  | "horizontal-scroll"
  | "horizontal-zoom"
  | "vertical-zoom";

export function pianoRollWheelAction(
  ctrlKey: boolean,
  shiftKey: boolean,
): PianoRollWheelAction {
  if (shiftKey) {
    return "vertical-zoom";
  }
  if (ctrlKey) {
    return "horizontal-zoom";
  }
  return "horizontal-scroll";
}

export function zoomFromWheel(
  currentZoom: number,
  deltaY: number,
  minimumZoom: number,
  maximumZoom: number,
): number {
  if (
    !Number.isFinite(currentZoom) ||
    !Number.isFinite(deltaY) ||
    deltaY === 0
  ) {
    return currentZoom;
  }
  const factor = deltaY < 0 ? 1.15 : 1 / 1.15;
  return Math.min(
    maximumZoom,
    Math.max(minimumZoom, currentZoom * factor),
  );
}

export function zoomedScrollOffset(
  scrollOffset: number,
  pointerOffset: number,
  currentScale: number,
  nextScale: number,
): number {
  if (
    !Number.isFinite(scrollOffset) ||
    !Number.isFinite(pointerOffset) ||
    !Number.isFinite(currentScale) ||
    !Number.isFinite(nextScale) ||
    currentScale <= 0 ||
    nextScale <= 0
  ) {
    return Math.max(0, scrollOffset);
  }
  const anchoredUnit = (scrollOffset + pointerOffset) / currentScale;
  return Math.max(0, anchoredUnit * nextScale - pointerOffset);
}

export function buildBeatGridLines(
  startSec: number,
  endSec: number,
  bpm: number,
  beatOffsetSec: number,
  numerator: number,
  denominator: number,
): BeatGridLine[] {
  if (
    !Number.isFinite(startSec) ||
    !Number.isFinite(endSec) ||
    !Number.isFinite(bpm) ||
    !Number.isFinite(beatOffsetSec) ||
    endSec < startSec ||
    bpm <= 0 ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return [];
  }
  const beatDurationSec = (60 / bpm) * (4 / denominator);
  const firstBeatIndex = Math.max(
    0,
    Math.ceil((startSec - beatOffsetSec) / beatDurationSec - 1e-9),
  );
  const lastBeatIndex = Math.floor(
    (endSec - beatOffsetSec) / beatDurationSec + 1e-9,
  );
  const lines: BeatGridLine[] = [];
  for (
    let beatIndex = firstBeatIndex;
    beatIndex <= lastBeatIndex;
    beatIndex += 1
  ) {
    const beatInMeasure = (beatIndex % numerator) + 1;
    lines.push({
      timeSec: beatOffsetSec + beatIndex * beatDurationSec,
      measureNumber: Math.floor(beatIndex / numerator) + 1,
      beatInMeasure,
      isMeasureStart: beatInMeasure === 1,
    });
  }
  return lines;
}

export function snapTimeToQuarterNote(
  timeSec: number,
  bpm: number,
  beatOffsetSec: number,
  durationSec: number,
): number {
  const maximum = Number.isFinite(durationSec)
    ? Math.max(0, durationSec)
    : 0;
  const normalized = Math.min(
    maximum,
    Math.max(0, Number.isFinite(timeSec) ? timeSec : 0),
  );
  if (
    !Number.isFinite(bpm) ||
    bpm <= 0 ||
    !Number.isFinite(beatOffsetSec)
  ) {
    return normalized;
  }
  const quarterNoteSec = 60 / bpm;
  const quarterIndex = Math.floor(
    (normalized - beatOffsetSec) / quarterNoteSec + 1e-9,
  );
  return Math.min(
    maximum,
    Math.max(0, beatOffsetSec + quarterIndex * quarterNoteSec),
  );
}

export function buildNoteTimeIndex(notes: ProjectNote[]): NoteTimeIndex {
  const sorted = [...notes].sort(
    (left, right) =>
      left.startSec - right.startSec ||
      left.pitch - right.pitch ||
      left.id.localeCompare(right.id),
  );
  const prefixMaxEnd: number[] = [];
  let maximum = 0;
  for (const note of sorted) {
    maximum = Math.max(maximum, note.endSec);
    prefixMaxEnd.push(maximum);
  }
  return { notes: sorted, prefixMaxEnd };
}

function firstGreaterThan(values: ProjectNote[], timeSec: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle].startSec <= timeSec) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function firstPrefixAtLeast(values: number[], timeSec: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < timeSec) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function findVisibleNotes(
  index: NoteTimeIndex,
  startSec: number,
  endSec: number,
): ProjectNote[] {
  if (index.notes.length === 0 || endSec < startSec) {
    return [];
  }
  const upper = firstGreaterThan(index.notes, endSec);
  const lower = Math.min(firstPrefixAtLeast(index.prefixMaxEnd, startSec), upper);
  return index.notes
    .slice(lower, upper)
    .filter((note) => note.endSec >= startSec);
}

export function noteRectangle(
  note: ProjectNote,
  viewport: RollViewport,
  minimumWidth = 3,
): Rectangle {
  const pitchRow = viewport.pitchRows?.indexOf(note.pitch);
  return {
    x: note.startSec * viewport.pixelsPerSecond - viewport.scrollLeft,
    y:
      viewport.headerHeight +
      (pitchRow === undefined
        ? (viewport.maxPitch ?? 127) - note.pitch
        : pitchRow) *
        viewport.rowHeight -
      viewport.scrollTop,
    width: Math.max(
      minimumWidth,
      (note.endSec - note.startSec) * viewport.pixelsPerSecond,
    ),
    height: Math.max(3, viewport.rowHeight - 1),
  };
}

export function timeToViewportX(
  timeSec: number,
  viewport: RollViewport,
): number {
  return timeSec * viewport.pixelsPerSecond - viewport.scrollLeft;
}

export function playheadFollowScrollLeft(
  playheadSec: number,
  scrollLeft: number,
  viewportWidth: number,
  pixelsPerSecond: number,
  contentWidth: number,
): number | null {
  const playheadContentX = playheadSec * pixelsPerSecond;
  const safeLeft = scrollLeft + viewportWidth * 0.2;
  const safeRight = scrollLeft + viewportWidth * 0.8;
  if (playheadContentX >= safeLeft && playheadContentX <= safeRight) {
    return null;
  }
  return Math.min(
    Math.max(0, playheadContentX - viewportWidth * 0.25),
    Math.max(0, contentWidth - viewportWidth),
  );
}

export function normalizedRectangle(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): Rectangle {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

export function rectanglesIntersect(left: Rectangle, right: Rectangle): boolean {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
  );
}

export function noteAtPoint(
  index: NoteTimeIndex,
  point: Pick<Rectangle, "x" | "y">,
  viewport: RollViewport,
  minimumNoteWidth = 3,
): ProjectNote | undefined {
  const pointSec =
    (point.x + viewport.scrollLeft) / viewport.pixelsPerSecond;
  const candidates = findVisibleNotes(
    index,
    Math.max(0, pointSec - minimumNoteWidth / viewport.pixelsPerSecond),
    pointSec,
  );
  for (let candidate = candidates.length - 1; candidate >= 0; candidate -= 1) {
    const note = candidates[candidate];
    if (
      rectanglesIntersect(noteRectangle(note, viewport, minimumNoteWidth), {
        x: point.x,
        y: point.y,
        width: 0,
        height: 0,
      })
    ) {
      return note;
    }
  }
  return undefined;
}

export function notesIntersectingRectangle(
  index: NoteTimeIndex,
  selection: Rectangle,
  viewport: RollViewport,
  minimumNoteWidth = 3,
): ProjectNote[] {
  const startSec = Math.max(
    0,
    (selection.x + viewport.scrollLeft - minimumNoteWidth) /
      viewport.pixelsPerSecond,
  );
  const endSec =
    (selection.x + selection.width + viewport.scrollLeft) /
    viewport.pixelsPerSecond;
  return findVisibleNotes(index, startSec, endSec).filter((note) =>
    rectanglesIntersect(
      noteRectangle(note, viewport, minimumNoteWidth),
      selection,
    ),
  );
}
