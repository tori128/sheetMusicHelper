import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
} from "react";
import type { ProjectNote, ProjectTrack, QuantizeGrid } from "../types";
import { Localized } from "../i18n";
import {
  gridDurationSeconds,
  snapTimeToGrid,
} from "../store/project-editing";
import type { EstimatedChordSpan } from "./chord-estimation";
import {
  normalizeSpectralDifferenceForDisplay,
  spectralDifferenceColor,
  type SpectralDifferenceInterval,
} from "../spectral-difference";
import {
  isStandardDrumPitch,
  STANDARD_DRUM_NAMES,
  visibleDrumPitchRows,
} from "./drum-pitches";
import {
  buildBeatGridLines,
  buildNoteTimeIndex,
  findVisibleNotes,
  normalizedRectangle,
  noteAtPoint,
  noteRectangle,
  notesIntersectingRectangle,
  pianoRollWheelAction,
  playheadFollowScrollLeft,
  snapTimeToQuarterNote,
  timeToViewportX,
  zoomedScrollOffset,
  zoomFromWheel,
  type Rectangle,
  type RollViewport,
} from "./piano-roll-math";

export type PianoRollTool = "select" | "draw" | "erase";

interface PianoRollCanvasProps {
  notes: ProjectNote[];
  tracks: ProjectTrack[];
  durationSec: number;
  horizontalZoom: number;
  verticalZoom: number;
  bpm: number;
  beatOffsetSec: number;
  timeSignature: {
    numerator: number;
    denominator: number;
  };
  chordSpans: readonly EstimatedChordSpan[];
  spectralDifferences?: readonly SpectralDifferenceInterval[];
  mode: "pitched" | "drums";
  selectedNoteIds: ReadonlySet<string>;
  initialScrollTimeSec: number;
  playheadSec: number;
  followPlayhead: boolean;
  editingLocked: boolean;
  tool: PianoRollTool;
  quantizeGrid: QuantizeGrid;
  editTargetTrackId: string;
  onSelectionChange(noteIds: ReadonlySet<string>): void;
  onNotePreviewStart(note: ProjectNote): void;
  onNotePreviewEnd(immediate: boolean): void;
  onMoveNotes(offsetSec: number, pitchOffset: number): void;
  onResizeNoteStart?(noteId: string, startSec: number): void;
  onResizeNote(noteId: string, endSec: number): void;
  onCreateNote(note: {
    trackId: string;
    pitch: number;
    startSec: number;
    endSec: number;
  }): void;
  onDeleteNotes(noteIds: ReadonlySet<string>): void;
  onSeek(timeSec: number): void;
  onScrollTimeChange(timeSec: number): void;
  onZoomChange(horizontalZoom: number, verticalZoom: number): void;
}

interface Point {
  x: number;
  y: number;
}

type NoteEditPreview =
  | {
      kind: "move";
      noteIds: ReadonlySet<string>;
      offsetSec: number;
      pitchOffset: number;
    }
  | {
      kind: "resize-start";
      noteId: string;
      startSec: number;
    }
  | {
      kind: "resize-end";
      noteId: string;
      endSec: number;
    }
  | {
      kind: "create";
      note: ProjectNote;
    };

interface NoteGesture {
  pointerId: number;
  kind: "move" | "resize-start" | "resize-end";
  noteId: string;
  noteIds: ReadonlySet<string>;
  originX: number;
  originY: number;
  originalStartSec: number;
  originalEndSec: number;
  minimumOffsetSec: number;
  maximumOffsetSec: number;
  offsetSec: number;
  minimumPitchOffset: number;
  maximumPitchOffset: number;
  pitchOffset: number;
  startSec: number;
  endSec: number;
  dragged: boolean;
}

interface DrawGesture {
  pointerId: number;
  anchorTimeSec: number;
  note: ProjectNote;
}

const PIXELS_PER_SECOND = 90;
const ROW_HEIGHT = 12;
const DRUM_ROW_HEIGHT = 18;
const HEADER_HEIGHT = 48;
const CHORD_LABEL_Y = 13;
const SPECTRAL_DIFFERENCE_Y = 18;
const SPECTRAL_DIFFERENCE_HEIGHT = 4;
const MEASURE_LABEL_Y = 32;
const TIME_LABEL_Y = 45;
const BEAT_LABEL_Y = 39;
const DRUM_NOTE_MINIMUM_WIDTH = 14;
const PITCHED_NOTE_MINIMUM_WIDTH = 3;
const ADJACENT_NOTE_DISPLAY_GAP = 2;
const MINIMUM_HORIZONTAL_ZOOM = 0.25;
const MAXIMUM_HORIZONTAL_ZOOM = 4;
const MINIMUM_VERTICAL_ZOOM = 0.5;
const MAXIMUM_VERTICAL_ZOOM = 3;

export function PianoRollCanvas({
  notes,
  tracks,
  durationSec,
  horizontalZoom,
  verticalZoom,
  bpm,
  beatOffsetSec,
  timeSignature,
  chordSpans,
  spectralDifferences = [],
  mode,
  selectedNoteIds,
  initialScrollTimeSec,
  playheadSec,
  followPlayhead,
  editingLocked,
  tool,
  quantizeGrid,
  editTargetTrackId,
  onSelectionChange,
  onNotePreviewStart,
  onNotePreviewEnd,
  onMoveNotes,
  onResizeNoteStart = () => undefined,
  onResizeNote,
  onCreateNote,
  onDeleteNotes,
  onSeek,
  onScrollTimeChange,
  onZoomChange,
}: PianoRollCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragStart = useRef<Point | null>(null);
  const dragAdditive = useRef(false);
  const activePointerId = useRef<number | null>(null);
  const notePreviewActive = useRef(false);
  const onNotePreviewEndRef = useRef(onNotePreviewEnd);
  const noteGesture = useRef<NoteGesture | null>(null);
  const drawGesture = useRef<DrawGesture | null>(null);
  const positionedInitially = useRef(false);
  const positionedHorizontally = useRef(false);
  const requestedZoom = useRef({ horizontalZoom, verticalZoom });
  const pendingZoomAnchor = useRef<{
    axis: "horizontal" | "vertical";
    scrollOffset: number;
    pointerOffset: number;
    scale: number;
  } | null>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const spectralDifferenceRange = useMemo(() => {
    if (spectralDifferences.length === 0) {
      return null;
    }
    return spectralDifferences.reduce(
      (range, interval) => ({
        minimum: Math.min(range.minimum, interval.value),
        maximum: Math.max(range.maximum, interval.value),
      }),
      { minimum: Number.POSITIVE_INFINITY, maximum: Number.NEGATIVE_INFINITY },
    );
  }, [spectralDifferences]);
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [selection, setSelection] = useState<Rectangle | null>(null);
  const [noteEditPreview, setNoteEditPreview] =
    useState<NoteEditPreview | null>(null);
  const rollNotes = useMemo(
    () =>
      mode === "drums"
        ? notes.filter((note) => isStandardDrumPitch(note.pitch))
        : notes,
    [mode, notes],
  );
  const drumPitchRows = useMemo(
    () => visibleDrumPitchRows(rollNotes.map((note) => note.pitch)),
    [rollNotes],
  );
  const index = useMemo(() => buildNoteTimeIndex(rollNotes), [rollNotes]);
  const trackColors = useMemo(
    () => new Map(tracks.map((track) => [track.id, track.color])),
    [tracks],
  );
  const pixelsPerSecond = PIXELS_PER_SECOND * horizontalZoom;
  const rowHeight =
    (mode === "drums" ? DRUM_ROW_HEIGHT : ROW_HEIGHT) * verticalZoom;
  const minimumPitch = 0;
  const maximumPitch = 127;
  const minimumNoteWidth =
    mode === "drums"
      ? DRUM_NOTE_MINIMUM_WIDTH
      : PITCHED_NOTE_MINIMUM_WIDTH;
  const contentWidth = Math.max(
    size.width,
    Math.ceil(Math.max(durationSec, 10) * pixelsPerSecond),
  );
  const pitchRowCount =
    mode === "drums"
      ? drumPitchRows.length
      : maximumPitch - minimumPitch + 1;
  const contentHeight = HEADER_HEIGHT + pitchRowCount * rowHeight;
  const viewport = useMemo<RollViewport>(
    () => ({
      scrollLeft: scroll.left,
      scrollTop: scroll.top,
      width: size.width,
      height: size.height,
      pixelsPerSecond,
      rowHeight,
      headerHeight: HEADER_HEIGHT,
      maxPitch: maximumPitch,
      pitchRows: mode === "drums" ? drumPitchRows : undefined,
    }),
    [drumPitchRows, maximumPitch, mode, pixelsPerSecond, rowHeight, scroll, size],
  );

  useEffect(() => {
    onNotePreviewEndRef.current = onNotePreviewEnd;
  }, [onNotePreviewEnd]);

  useEffect(() => {
    if (editingLocked) {
      cancelActivePointerInteraction();
    }
  }, [editingLocked]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        cancelActivePointerInteraction();
      }
    };
    window.addEventListener("blur", cancelActivePointerInteraction);
    window.addEventListener("pointercancel", cancelActivePointerInteraction);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", cancelActivePointerInteraction);
      window.removeEventListener(
        "pointercancel",
        cancelActivePointerInteraction,
      );
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
    };
  }, []);

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      const container = containerRef.current;
      const wheelDelta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      if (container === null || wheelDelta === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const action = pianoRollWheelAction(event.ctrlKey, event.shiftKey);
      if (action === "horizontal-scroll") {
        container.scrollLeft += wheelDelta;
        return;
      }

      const bounds = container.getBoundingClientRect();
      const zoom = requestedZoom.current;
      if (action === "vertical-zoom") {
        const nextVerticalZoom = zoomFromWheel(
          zoom.verticalZoom,
          wheelDelta,
          MINIMUM_VERTICAL_ZOOM,
          MAXIMUM_VERTICAL_ZOOM,
        );
        if (nextVerticalZoom === zoom.verticalZoom) {
          return;
        }
        pendingZoomAnchor.current = {
          axis: "vertical",
          scrollOffset: container.scrollTop,
          pointerOffset: Math.max(
            0,
            Math.min(container.clientHeight, event.clientY - bounds.top) -
              HEADER_HEIGHT,
          ),
          scale: rowHeight,
        };
        requestedZoom.current = {
          horizontalZoom: zoom.horizontalZoom,
          verticalZoom: nextVerticalZoom,
        };
        onZoomChange(zoom.horizontalZoom, nextVerticalZoom);
        return;
      }

      const nextHorizontalZoom = zoomFromWheel(
        zoom.horizontalZoom,
        wheelDelta,
        MINIMUM_HORIZONTAL_ZOOM,
        MAXIMUM_HORIZONTAL_ZOOM,
      );
      if (nextHorizontalZoom === zoom.horizontalZoom) {
        return;
      }
      pendingZoomAnchor.current = {
        axis: "horizontal",
        scrollOffset: container.scrollLeft,
        pointerOffset: Math.max(
          0,
          Math.min(container.clientWidth, event.clientX - bounds.left),
        ),
        scale: pixelsPerSecond,
      };
      requestedZoom.current = {
        horizontalZoom: nextHorizontalZoom,
        verticalZoom: zoom.verticalZoom,
      };
      onZoomChange(nextHorizontalZoom, zoom.verticalZoom);
    },
    [onZoomChange, pixelsPerSecond, rowHeight],
  );

  useEffect(() => {
    requestedZoom.current = { horizontalZoom, verticalZoom };
  }, [horizontalZoom, verticalZoom]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [handleWheel]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const anchor = pendingZoomAnchor.current;
    if (container === null || anchor === null) {
      return;
    }
    pendingZoomAnchor.current = null;
    if (anchor.axis === "horizontal") {
      container.scrollLeft = zoomedScrollOffset(
        anchor.scrollOffset,
        anchor.pointerOffset,
        anchor.scale,
        pixelsPerSecond,
      );
    } else {
      container.scrollTop = zoomedScrollOffset(
        anchor.scrollOffset,
        anchor.pointerOffset,
        anchor.scale,
        rowHeight,
      );
    }
  }, [contentHeight, contentWidth, pixelsPerSecond, rowHeight]);

  useEffect(() => {
    positionedInitially.current = false;
  }, [mode]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const update = () =>
      setSize({
        width: Math.max(1, container.clientWidth),
        height: Math.max(1, container.clientHeight),
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (
      container === null ||
      positionedInitially.current ||
      size.height <= 1
    ) {
      return;
    }
    positionedInitially.current = true;
    container.scrollTop =
      mode === "drums"
        ? 0
        : Math.max(
            0,
            HEADER_HEIGHT + (maximumPitch - 60) * rowHeight - size.height / 2,
          );
  }, [maximumPitch, mode, rowHeight, size.height]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || positionedHorizontally.current) {
      return;
    }
    positionedHorizontally.current = true;
    container.scrollLeft = initialScrollTimeSec * pixelsPerSecond;
  }, [initialScrollTimeSec, pixelsPerSecond]);

  useEffect(() => {
    const container = containerRef.current;
    if (!followPlayhead || container === null) {
      return;
    }
    const nextScrollLeft = playheadFollowScrollLeft(
      playheadSec,
      container.scrollLeft,
      size.width,
      pixelsPerSecond,
      contentWidth,
    );
    if (
      nextScrollLeft !== null &&
      Math.abs(nextScrollLeft - container.scrollLeft) > 1
    ) {
      container.scrollLeft = nextScrollLeft;
    }
  }, [
    contentWidth,
    followPlayhead,
    pixelsPerSecond,
    playheadSec,
    size.width,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(size.width * scale));
    canvas.height = Math.max(1, Math.floor(size.height * scale));
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.fillStyle = "#0c1016";
    context.fillRect(0, 0, size.width, size.height);

    context.lineWidth = 1;
    const firstPitchRow = Math.max(
      0,
      Math.floor((scroll.top - HEADER_HEIGHT) / rowHeight),
    );
    const lastPitchRow = Math.min(
      pitchRowCount - 1,
      Math.ceil((scroll.top + size.height - HEADER_HEIGHT) / rowHeight),
    );
    for (
      let pitchRow = firstPitchRow;
      pitchRow <= lastPitchRow;
      pitchRow += 1
    ) {
      const pitch =
        mode === "drums"
          ? drumPitchRows[pitchRow]
          : maximumPitch - pitchRow;
      const y = HEADER_HEIGHT + pitchRow * rowHeight - scroll.top;
      context.strokeStyle =
        mode === "drums" || pitch % 12 === 0 ? "#293141" : "#191f2a";
      context.beginPath();
      context.moveTo(0, Math.round(y) + 0.5);
      context.lineTo(size.width, Math.round(y) + 0.5);
      context.stroke();
      if (mode === "drums") {
        context.fillStyle = "#788397";
        context.font = "9px Consolas";
        context.fillText(
          `${pitch} ${STANDARD_DRUM_NAMES[pitch]}`,
          4,
          y + Math.min(10, rowHeight - 2),
        );
      } else if (pitch % 12 === 0) {
        context.fillStyle = "#697487";
        context.font = "10px Consolas";
        context.fillText(`C${Math.floor(pitch / 12) - 1}`, 4, y + 10);
      }
    }

    context.fillStyle = "#121822";
    context.fillRect(0, 0, size.width, HEADER_HEIGHT);
    context.strokeStyle = "#293141";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, 17.5);
    context.lineTo(size.width, 17.5);
    context.stroke();

    const startSec = Math.max(0, scroll.left / pixelsPerSecond);
    const endSec = (scroll.left + size.width) / pixelsPerSecond;
    const beatDurationSec = (60 / bpm) * (4 / timeSignature.denominator);
    const beatSpacing = beatDurationSec * pixelsPerSecond;
    const measureSpacing = beatSpacing * timeSignature.numerator;
    const labeledMeasureInterval = Math.max(
      1,
      Math.ceil(52 / Math.max(1, measureSpacing)),
    );
    const beatLines = buildBeatGridLines(
      startSec,
      endSec,
      bpm,
      beatOffsetSec,
      timeSignature.numerator,
      timeSignature.denominator,
    );
    if (spectralDifferences.length > 0) {
      for (const interval of spectralDifferences) {
        if (interval.endSec <= startSec || interval.startSec >= endSec) {
          continue;
        }
        const x = interval.startSec * pixelsPerSecond - scroll.left;
        const width = Math.max(
          1,
          (interval.endSec - interval.startSec) * pixelsPerSecond,
        );
        const displayValue = spectralDifferenceRange === null
          ? interval.value
          : normalizeSpectralDifferenceForDisplay(
              interval.value,
              spectralDifferenceRange.minimum,
              spectralDifferenceRange.maximum,
            );
        context.fillStyle = spectralDifferenceColor(displayValue);
        context.fillRect(
          x,
          SPECTRAL_DIFFERENCE_Y,
          width,
          SPECTRAL_DIFFERENCE_HEIGHT,
        );
      }
    }
    for (const line of beatLines) {
      if (!line.isMeasureStart && beatSpacing < 5) {
        continue;
      }
      const x = line.timeSec * pixelsPerSecond - scroll.left;
      context.strokeStyle = line.isMeasureStart ? "#46536a" : "#293446";
      context.lineWidth = line.isMeasureStart ? 1.5 : 1;
      context.beginPath();
      context.moveTo(Math.round(x) + 0.5, HEADER_HEIGHT);
      context.lineTo(Math.round(x) + 0.5, size.height);
      context.stroke();
      if (
        line.isMeasureStart &&
        (line.measureNumber - 1) % labeledMeasureInterval === 0
      ) {
        context.fillStyle = "#c4ccda";
        context.font = "bold 10px Consolas";
        context.fillText(`${line.measureNumber}`, x + 4, MEASURE_LABEL_Y);
        context.fillStyle = "#778397";
        context.font = "9px Consolas";
        context.fillText(
          `${line.timeSec.toFixed(1)}s`,
          x + 4,
          TIME_LABEL_Y,
        );
      } else if (!line.isMeasureStart && beatSpacing >= 32) {
        context.fillStyle = "#8a94a5";
        context.font = "9px Consolas";
        context.fillText(
          `${line.measureNumber}.${line.beatInMeasure}`,
          x + 3,
          BEAT_LABEL_Y,
        );
      }
    }
    if (beatSpacing >= 22) {
      for (const chord of chordSpans) {
        if (
          chord.endSec < startSec ||
          chord.startSec > endSec ||
          (chord.measureNumber - 1) % labeledMeasureInterval !== 0
        ) {
          continue;
        }
        const x = chord.startSec * pixelsPerSecond - scroll.left;
        const availableWidth =
          (chord.endSec - chord.startSec) * pixelsPerSecond;
        if (availableWidth < 24) {
          continue;
        }
        context.fillStyle = "#f0c66d";
        context.font = "bold 10px Consolas";
        context.fillText(
          chord.label,
          x + 4,
          CHORD_LABEL_Y,
          Math.max(16, availableWidth - 8),
        );
      }
    }
    context.strokeStyle = "#343d4d";
    context.beginPath();
    context.moveTo(0, HEADER_HEIGHT - 0.5);
    context.lineTo(size.width, HEADER_HEIGHT - 0.5);
    context.stroke();

    const visibleStartSec = Math.max(
      0,
      startSec - minimumNoteWidth / pixelsPerSecond,
    );
    let visibleNotes = findVisibleNotes(index, visibleStartSec, endSec);
    if (noteEditPreview?.kind === "move") {
      const sourceStart = Math.max(
        0,
        visibleStartSec - noteEditPreview.offsetSec,
      );
      const sourceEnd = Math.max(0, endSec - noteEditPreview.offsetSec);
      const movedNotes = findVisibleNotes(index, sourceStart, sourceEnd)
        .filter((note) => noteEditPreview.noteIds.has(note.id))
        .map((note) => ({
          ...note,
          pitch: note.pitch + noteEditPreview.pitchOffset,
          startSec: note.startSec + noteEditPreview.offsetSec,
          endSec: note.endSec + noteEditPreview.offsetSec,
        }));
      visibleNotes = [
        ...visibleNotes.filter(
          (note) => !noteEditPreview.noteIds.has(note.id),
        ),
        ...movedNotes,
      ];
    } else if (noteEditPreview?.kind === "resize-start") {
      visibleNotes = visibleNotes.map((note) =>
        note.id === noteEditPreview.noteId
          ? { ...note, startSec: noteEditPreview.startSec }
          : note,
      );
    } else if (noteEditPreview?.kind === "resize-end") {
      visibleNotes = visibleNotes.map((note) =>
        note.id === noteEditPreview.noteId
          ? { ...note, endSec: noteEditPreview.endSec }
          : note,
      );
    } else if (noteEditPreview?.kind === "create") {
      visibleNotes = [...visibleNotes, noteEditPreview.note];
    }
    const noteStartTimesByPitch = new Map<number, Set<number>>();
    for (const note of visibleNotes) {
      const startTimes =
        noteStartTimesByPitch.get(note.pitch) ?? new Set<number>();
      startTimes.add(note.startSec);
      noteStartTimesByPitch.set(note.pitch, startTimes);
    }
    for (const note of visibleNotes) {
      const rectangle = noteRectangle(note, viewport, minimumNoteWidth);
      if (
        rectangle.y + rectangle.height < HEADER_HEIGHT ||
        rectangle.y > size.height
      ) {
        continue;
      }
      const isSelected =
        selectedNoteIds.has(note.id) ||
        (noteEditPreview?.kind === "create" &&
          noteEditPreview.note.id === note.id);
      const hasAdjacentNote = noteStartTimesByPitch
        .get(note.pitch)
        ?.has(note.endSec);
      const displayWidth = Math.max(
        minimumNoteWidth,
        rectangle.width -
          (hasAdjacentNote ? ADJACENT_NOTE_DISPLAY_GAP : 0),
      );
      context.fillStyle = trackColors.get(note.trackId) ?? "#7c6cff";
      context.globalAlpha = isSelected ? 1 : 0.82;
      context.fillRect(
        rectangle.x,
        rectangle.y,
        displayWidth,
        rectangle.height,
      );
      if (isSelected) {
        context.strokeStyle = "#ffffff";
        context.lineWidth = 1.5;
        context.strokeRect(
          rectangle.x + 0.5,
          rectangle.y + 0.5,
          Math.max(0, displayWidth - 1),
          Math.max(0, rectangle.height - 1),
        );
        if (displayWidth >= 8) {
          context.strokeStyle = "#ffffff";
          context.lineWidth = 2;
          context.beginPath();
          context.moveTo(
            rectangle.x + displayWidth - 1,
            rectangle.y + 2,
          );
          context.lineTo(
            rectangle.x + displayWidth - 1,
            rectangle.y + rectangle.height - 2,
          );
          context.stroke();
        }
      }
    }
    context.globalAlpha = 1;
    if (selection !== null) {
      context.fillStyle =
        tool === "erase"
          ? "rgba(239, 119, 119, 0.18)"
          : "rgba(124, 108, 255, 0.18)";
      context.strokeStyle = tool === "erase" ? "#ff9696" : "#a99fff";
      context.lineWidth = 1;
      context.fillRect(
        selection.x,
        selection.y,
        selection.width,
        selection.height,
      );
      context.strokeRect(
        selection.x + 0.5,
        selection.y + 0.5,
        selection.width,
        selection.height,
      );
    }
    const playheadX = timeToViewportX(playheadSec, viewport);
    if (playheadX >= 0 && playheadX <= size.width) {
      context.strokeStyle = "#ff5d73";
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(Math.round(playheadX) + 0.5, HEADER_HEIGHT);
      context.lineTo(Math.round(playheadX) + 0.5, size.height);
      context.stroke();
    }
  }, [
    chordSpans,
    spectralDifferences,
    spectralDifferenceRange,
    drumPitchRows,
    index,
    noteEditPreview,
    scroll,
    selectedNoteIds,
    selection,
    size,
    trackColors,
    viewport,
    pixelsPerSecond,
    rowHeight,
    beatOffsetSec,
    bpm,
    maximumPitch,
    pitchRowCount,
    mode,
    minimumNoteWidth,
    playheadSec,
    timeSignature,
    tool,
  ]);

  function pointFromEvent(
    event: ReactPointerEvent<HTMLCanvasElement>,
  ): Point {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function visibleHit(point: Point): ProjectNote | undefined {
    return noteAtPoint(index, point, viewport, minimumNoteWidth);
  }

  function resizeThresholdFor(note: ProjectNote): number {
    const rectangle = noteRectangle(note, viewport, minimumNoteWidth);
    return Math.min(10, Math.max(4, rectangle.width / 3));
  }

  function selectedResizeHit(
    point: Point,
  ): { note: ProjectNote; edge: "start" | "end" } | undefined {
    for (let noteIndex = rollNotes.length - 1; noteIndex >= 0; noteIndex -= 1) {
      const note = rollNotes[noteIndex];
      if (!selectedNoteIds.has(note.id)) {
        continue;
      }
      const rectangle = noteRectangle(note, viewport, minimumNoteWidth);
      const left = rectangle.x;
      const right = rectangle.x + rectangle.width;
      const threshold = resizeThresholdFor(note);
      const insideRow =
        point.y >= rectangle.y &&
        point.y <= rectangle.y + rectangle.height;
      const startHit =
        point.x >= left - 2 &&
        point.x <= left + threshold &&
        insideRow;
      const endHit =
        point.x >= right - threshold &&
        point.x <= right + 2 &&
        insideRow;
      if (startHit || endHit) {
        return {
          note,
          edge:
            startHit && (!endHit || Math.abs(point.x - left) <= Math.abs(point.x - right))
              ? "start"
              : "end",
        };
      }
    }
    return undefined;
  }

  function idleCursor(): "default" | "crosshair" {
    return tool === "select" ? "default" : "crosshair";
  }

  function beginNotePreview(note: ProjectNote) {
    notePreviewActive.current = true;
    onNotePreviewStart(note);
  }

  function endNotePreview(immediate: boolean) {
    if (!notePreviewActive.current) {
      return;
    }
    notePreviewActive.current = false;
    onNotePreviewEnd(immediate);
  }

  function pitchAtPoint(point: Point): number | null {
    const row = Math.floor(
      (point.y + scroll.top - HEADER_HEIGHT) / rowHeight,
    );
    if (row < 0 || row >= pitchRowCount) {
      return null;
    }
    if (mode === "drums") {
      return drumPitchRows[row] ?? null;
    }
    return maximumPitch - row;
  }

  function createDraftNote(point: Point): ProjectNote | null {
    const track = tracks.find(({ id }) => id === editTargetTrackId);
    const pitch = pitchAtPoint(point);
    if (
      track === undefined ||
      pitch === null ||
      (mode === "drums" ? track.kind !== "drums" : track.kind !== "pitched")
    ) {
      return null;
    }
    const gridSec = gridDurationSeconds(bpm, quantizeGrid);
    const pointedTimeSec =
      (point.x + scroll.left) / pixelsPerSecond;
    const snappedStartSec = Math.min(
      Math.max(0, durationSec - gridSec),
      snapTimeToGrid(
        pointedTimeSec,
        bpm,
        quantizeGrid,
        beatOffsetSec,
      ),
    );
    const endSec = Math.min(durationSec, snappedStartSec + gridSec);
    if (endSec <= snappedStartSec) {
      return null;
    }
    return {
      id: "piano-roll-draft",
      sourceInstrumentId: track.instrumentId,
      trackId: track.id,
      pitch,
      rawStartSec: snappedStartSec,
      rawEndSec: endSec,
      startSec: snappedStartSec,
      endSec,
      velocity: 100,
    };
  }

  function cancelActivePointerInteraction() {
    const pointerId = activePointerId.current;
    activePointerId.current = null;
    noteGesture.current = null;
    drawGesture.current = null;
    dragStart.current = null;
    setNoteEditPreview(null);
    setSelection(null);
    if (pointerId === null) {
      return;
    }
    const canvas = canvasRef.current;
    if (
      canvas !== null &&
      typeof canvas.hasPointerCapture === "function" &&
      canvas.hasPointerCapture(pointerId)
    ) {
      canvas.releasePointerCapture(pointerId);
    }
    if (canvas !== null) {
      canvas.style.cursor = idleCursor();
    }
    if (notePreviewActive.current) {
      notePreviewActive.current = false;
      onNotePreviewEndRef.current(true);
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) {
      return;
    }
    const point = pointFromEvent(event);
    if (point.y < HEADER_HEIGHT) {
      const clickedTimeSec =
        (scroll.left + Math.max(0, point.x)) / pixelsPerSecond;
      onSeek(
        snapTimeToQuarterNote(
          clickedTimeSec,
          bpm,
          beatOffsetSec,
          durationSec,
        ),
      );
      return;
    }
    const resizeHit =
      (tool === "select" || tool === "draw") && !editingLocked
        ? selectedResizeHit(point)
        : undefined;
    const hit = resizeHit?.note ?? visibleHit(point);
    if (tool === "erase") {
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointerId.current = event.pointerId;
      dragStart.current = point;
      setSelection({ x: point.x, y: point.y, width: 0, height: 0 });
      event.currentTarget.style.cursor = "crosshair";
      return;
    }
    if (tool === "draw" && hit === undefined) {
      const draft = createDraftNote(point);
      if (draft === null) {
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointerId.current = event.pointerId;
      drawGesture.current = {
        pointerId: event.pointerId,
        anchorTimeSec: draft.startSec,
        note: draft,
      };
      setNoteEditPreview({ kind: "create", note: draft });
      beginNotePreview(draft);
      event.currentTarget.style.cursor = "crosshair";
      return;
    }
    if (hit !== undefined) {
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointerId.current = event.pointerId;
      const next =
        event.shiftKey || selectedNoteIds.has(hit.id)
          ? new Set(selectedNoteIds)
          : new Set<string>();
      next.add(hit.id);
      onSelectionChange(next);
      if (editingLocked) {
        beginNotePreview(hit);
        event.currentTarget.style.cursor = "pointer";
        return;
      }
      const rectangle = noteRectangle(hit, viewport, minimumNoteWidth);
      const resizeThreshold = resizeThresholdFor(hit);
      const kind =
        resizeHit?.edge === "start"
          ? "resize-start"
          : resizeHit?.edge === "end" ||
              point.x >= rectangle.x + rectangle.width - resizeThreshold
            ? "resize-end"
            : "move";
      if (kind === "move") {
        beginNotePreview(hit);
      }
      const selectedNotes = notes.filter((note) => next.has(note.id));
      const earliestStart = Math.min(
        ...selectedNotes.map((note) => note.startSec),
      );
      const latestEnd = Math.max(
        ...selectedNotes.map((note) => note.endSec),
      );
      const lowestPitch = Math.min(
        ...selectedNotes.map((note) => note.pitch),
      );
      const highestPitch = Math.max(
        ...selectedNotes.map((note) => note.pitch),
      );
      noteGesture.current = {
        pointerId: event.pointerId,
        kind,
        noteId: hit.id,
        noteIds: next,
        originX: point.x,
        originY: point.y,
        originalStartSec: hit.startSec,
        originalEndSec: hit.endSec,
        minimumOffsetSec: -earliestStart,
        maximumOffsetSec: Math.max(
          -earliestStart,
          durationSec - latestEnd,
        ),
        offsetSec: 0,
        minimumPitchOffset: -lowestPitch,
        maximumPitchOffset: 127 - highestPitch,
        pitchOffset: 0,
        startSec: hit.startSec,
        endSec: hit.endSec,
        dragged: false,
      };
      event.currentTarget.style.cursor =
        kind === "resize-start" || kind === "resize-end"
          ? "ew-resize"
          : "grabbing";
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerId.current = event.pointerId;
    dragStart.current = point;
    dragAdditive.current = event.shiftKey;
    setSelection({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drawing = drawGesture.current;
    if (drawing !== null && drawing.pointerId === event.pointerId) {
      const point = pointFromEvent(event);
      const gridSec = gridDurationSeconds(bpm, quantizeGrid);
      const pointedTimeSec =
        (point.x + scroll.left) / pixelsPerSecond;
      const snappedTimeSec = Math.min(
        durationSec,
        snapTimeToGrid(
          pointedTimeSec,
          bpm,
          quantizeGrid,
          beatOffsetSec,
        ),
      );
      const startSec = Math.min(drawing.anchorTimeSec, snappedTimeSec);
      const endSec = Math.min(
        durationSec,
        snappedTimeSec <= drawing.anchorTimeSec
          ? drawing.anchorTimeSec + gridSec
          : snappedTimeSec,
      );
      const finalEndSec = Math.min(
        durationSec,
        Math.max(startSec + gridSec, endSec),
      );
      drawing.note = {
        ...drawing.note,
        rawStartSec: startSec,
        rawEndSec: finalEndSec,
        startSec,
        endSec: finalEndSec,
      };
      setNoteEditPreview({ kind: "create", note: drawing.note });
      return;
    }
    const gesture = noteGesture.current;
    if (gesture !== null && gesture.pointerId === event.pointerId) {
      const point = pointFromEvent(event);
      const deltaPixels = point.x - gesture.originX;
      const deltaPitchPixels = point.y - gesture.originY;
      if (
        !gesture.dragged &&
        Math.hypot(deltaPixels, deltaPitchPixels) < 2
      ) {
        return;
      }
      gesture.dragged = true;
      if (gesture.kind === "move") {
        const snappedStartSec = snapTimeToGrid(
          gesture.originalStartSec + deltaPixels / pixelsPerSecond,
          bpm,
          quantizeGrid,
          beatOffsetSec,
        );
        const offsetSec = Math.min(
          gesture.maximumOffsetSec,
          Math.max(
            gesture.minimumOffsetSec,
            snappedStartSec - gesture.originalStartSec,
          ),
        );
        const pitchOffset =
          mode === "pitched"
            ? Math.min(
                gesture.maximumPitchOffset,
                Math.max(
                  gesture.minimumPitchOffset,
                  Math.round(-deltaPitchPixels / rowHeight),
                ),
              )
            : 0;
        if (pitchOffset !== gesture.pitchOffset) {
          const note = notes.find(({ id }) => id === gesture.noteId);
          if (note !== undefined) {
            beginNotePreview({ ...note, pitch: note.pitch + pitchOffset });
          }
        }
        gesture.offsetSec = offsetSec;
        gesture.pitchOffset = pitchOffset;
        setNoteEditPreview({
          kind: "move",
          noteIds: gesture.noteIds,
          offsetSec,
          pitchOffset,
        });
      } else if (gesture.kind === "resize-start") {
        const note = notes.find(({ id }) => id === gesture.noteId);
        if (note !== undefined) {
          const gridSec = gridDurationSeconds(bpm, quantizeGrid);
          const snappedStartSec = snapTimeToGrid(
            gesture.originalStartSec + deltaPixels / pixelsPerSecond,
            bpm,
            quantizeGrid,
            beatOffsetSec,
          );
          setNoteEditPreview({
            kind: "resize-start",
            noteId: gesture.noteId,
            startSec: (gesture.startSec = Math.max(
              0,
              Math.min(note.endSec - gridSec, snappedStartSec),
            )),
          });
        }
      } else {
        const note = notes.find(({ id }) => id === gesture.noteId);
        if (note !== undefined) {
          const gridSec = gridDurationSeconds(bpm, quantizeGrid);
          const snappedEndSec = snapTimeToGrid(
            gesture.originalEndSec + deltaPixels / pixelsPerSecond,
            bpm,
            quantizeGrid,
            beatOffsetSec,
          );
          setNoteEditPreview({
            kind: "resize-end",
            noteId: gesture.noteId,
            endSec: (gesture.endSec = Math.min(
              durationSec,
              Math.max(note.startSec + gridSec, snappedEndSec),
            )),
          });
        }
      }
      return;
    }
    if (dragStart.current === null) {
      const point = pointFromEvent(event);
      if (point.y < HEADER_HEIGHT) {
        const timeSec = (point.x + scroll.left) / pixelsPerSecond;
        const interval = spectralDifferences.find(
          (candidate) =>
            candidate.startSec <= timeSec && candidate.endSec > timeSec,
        );
        event.currentTarget.title =
          interval === undefined
            ? ""
            : `原音との差 ${interval.value.toFixed(3)}（${interval.measureNumber}.${interval.beatInMeasure}）`;
        event.currentTarget.style.cursor = "pointer";
        return;
      }
      event.currentTarget.title = "";
      if (tool === "erase") {
        event.currentTarget.style.cursor = "crosshair";
        return;
      }
      const resizeHit = !editingLocked ? selectedResizeHit(point) : undefined;
      const hit = resizeHit?.note ?? visibleHit(point);
      if (hit === undefined) {
        event.currentTarget.style.cursor =
          tool === "draw" ? "crosshair" : "default";
        return;
      }
      if (editingLocked) {
        event.currentTarget.style.cursor = "pointer";
        return;
      }
      const rectangle = noteRectangle(hit, viewport, minimumNoteWidth);
      event.currentTarget.style.cursor =
        resizeHit !== undefined ||
        point.x >= rectangle.x + rectangle.width - resizeThresholdFor(hit)
          ? "ew-resize"
          : "grab";
      return;
    }
    const point = pointFromEvent(event);
    setSelection(
      normalizedRectangle(
        dragStart.current.x,
        dragStart.current.y,
        point.x,
        point.y,
      ),
    );
  }

  function finishSelection(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (dragStart.current === null) {
      return;
    }
    const point = pointFromEvent(event);
    const finalSelection = normalizedRectangle(
      dragStart.current.x,
      dragStart.current.y,
      point.x,
      point.y,
    );
    const isClick = finalSelection.width < 3 && finalSelection.height < 3;
    const intersecting = isClick
      ? (() => {
          const hit = visibleHit(point);
          return hit === undefined ? [] : [hit];
        })()
      : notesIntersectingRectangle(
        index,
        finalSelection,
        viewport,
        minimumNoteWidth,
      );
    if (tool === "erase") {
      onDeleteNotes(new Set(intersecting.map(({ id }) => id)));
    } else if (isClick) {
      onSelectionChange(new Set());
    } else {
      const next = dragAdditive.current
        ? new Set(selectedNoteIds)
        : new Set<string>();
      intersecting.forEach((note) => next.add(note.id));
      onSelectionChange(next);
    }
    dragStart.current = null;
    setSelection(null);
  }

  function finishPointerInteraction(
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) {
    if (activePointerId.current !== event.pointerId) {
      return;
    }
    const drawing = drawGesture.current;
    const gesture = noteGesture.current;
    activePointerId.current = null;
    drawGesture.current = null;
    noteGesture.current = null;
    setNoteEditPreview(null);
    if (drawing !== null) {
      onCreateNote({
        trackId: drawing.note.trackId,
        pitch: drawing.note.pitch,
        startSec: drawing.note.startSec,
        endSec: drawing.note.endSec,
      });
    } else if (gesture?.dragged && gesture.kind === "move") {
      onMoveNotes(gesture.offsetSec, gesture.pitchOffset);
    } else if (gesture?.dragged && gesture.kind === "resize-start") {
      onResizeNoteStart(gesture.noteId, gesture.startSec);
    } else if (gesture?.dragged && gesture.kind === "resize-end") {
      onResizeNote(gesture.noteId, gesture.endSec);
    } else {
      finishSelection(event);
    }
    endNotePreview(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.currentTarget.style.cursor = idleCursor();
  }

  function handleLostPointerCapture(
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) {
    if (activePointerId.current !== event.pointerId) {
      return;
    }
    cancelActivePointerInteraction();
  }

  function cancelPointerInteraction(
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) {
    if (activePointerId.current === event.pointerId) {
      cancelActivePointerInteraction();
      return;
    }
    dragStart.current = null;
    setSelection(null);
  }

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    setScroll({
      left: event.currentTarget.scrollLeft,
      top: event.currentTarget.scrollTop,
    });
    onScrollTimeChange(event.currentTarget.scrollLeft / pixelsPerSecond);
  }

  return (
    <Localized>
    <div
      className="piano-roll-viewport"
      ref={containerRef}
      onScroll={handleScroll}
      aria-readonly={editingLocked}
      aria-label={mode === "drums" ? "ドラムロール" : "統合ピアノロール"}
    >
      <div
        className="piano-roll-content"
        style={{ width: contentWidth, height: contentHeight }}
      >
        <canvas
          className="piano-roll-canvas"
          data-tool={tool}
          ref={canvasRef}
          style={{ left: scroll.left, top: scroll.top }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerInteraction}
          onPointerCancel={cancelPointerInteraction}
          onLostPointerCapture={handleLostPointerCapture}
          onPointerLeave={(event) => {
            event.currentTarget.title = "";
            if (
              activePointerId.current === null &&
              dragStart.current === null
            ) {
              event.currentTarget.style.cursor = idleCursor();
            }
          }}
          onContextMenu={(event) => event.preventDefault()}
        />
      </div>
    </div>
    </Localized>
  );
}
