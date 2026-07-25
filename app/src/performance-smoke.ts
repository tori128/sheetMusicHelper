import {
  buildNoteTimeIndex,
  findVisibleNotes,
  noteRectangle,
  playheadFollowScrollLeft,
} from "./components/piano-roll-math";
import type { ProjectNote } from "./types";

export interface PerformanceSmokeResult {
  noteCount: number;
  frames: number;
  indexMs: number;
  renderMs: number;
  maxVisible: number;
  followScrollLeft: number | null;
}

export function runPerformanceSmoke(): PerformanceSmokeResult {
  const noteCount = 100_000;
  const durationSec = 1_800;
  const notes: ProjectNote[] = Array.from({ length: noteCount }, (_, index) => {
    const startSec = (index * durationSec) / noteCount;
    return {
      id: `performance-${index}`,
      sourceInstrumentId: "acoustic_piano",
      trackId: "performance-track",
      pitch: 36 + (index % 61),
      rawStartSec: startSec,
      rawEndSec: startSec + 0.2,
      startSec,
      endSec: startSec + 0.2,
      velocity: 100,
    };
  });
  const indexStarted = performance.now();
  const timeIndex = buildNoteTimeIndex(notes);
  const indexMs = performance.now() - indexStarted;
  const canvas = document.createElement("canvas");
  canvas.width = 1_280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Canvas 2Dコンテキストを作成できません");
  }

  const frames = 360;
  let maxVisible = 0;
  const renderStarted = performance.now();
  for (let frame = 0; frame < frames; frame += 1) {
    const horizontalZoom = 0.25 + (frame % 16) * 0.25;
    const verticalZoom = 0.5 + (frame % 11) * 0.25;
    const pixelsPerSecond = 90 * horizontalZoom;
    const rowHeight = 12 * verticalZoom;
    const startSec = ((frame * 5.13) % (durationSec - 20));
    const endSec = startSec + canvas.width / pixelsPerSecond;
    const visible = findVisibleNotes(timeIndex, startSec, endSec);
    maxVisible = Math.max(maxVisible, visible.length);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#4C9AFF";
    for (const note of visible) {
      const rectangle = noteRectangle(note, {
        scrollLeft: startSec * pixelsPerSecond,
        scrollTop: 360,
        width: canvas.width,
        height: canvas.height,
        pixelsPerSecond,
        rowHeight,
        headerHeight: 28,
      });
      if (rectangle.y + rectangle.height >= 28 && rectangle.y <= canvas.height) {
        context.fillRect(
          rectangle.x,
          rectangle.y,
          rectangle.width,
          rectangle.height,
        );
      }
    }
  }
  return {
    noteCount,
    frames,
    indexMs,
    renderMs: performance.now() - renderStarted,
    maxVisible,
    followScrollLeft: playheadFollowScrollLeft(
      10,
      0,
      800,
      100,
      5_000,
    ),
  };
}
