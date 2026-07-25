import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type UIEvent,
} from "react";
import type { ProjectNote, ProjectTrack } from "../types";
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
  timeToViewportX,
  zoomedScrollOffset,
  zoomFromWheel,
  type Rectangle,
  type RollViewport,
} from "./piano-roll-math";

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
  mode: "pitched" | "drums";
  selectedNoteIds: ReadonlySet<string>;
  initialScrollTimeSec: number;
  playheadSec: number;
  followPlayhead: boolean;
  onSelectionChange(noteIds: ReadonlySet<string>): void;
  onNotePreview(note: ProjectNote): void;
  onScrollTimeChange(timeSec: number): void;
  onZoomChange(horizontalZoom: number, verticalZoom: number): void;
  onNoteContextMenu(noteId: string, point: Point): void;
}

interface Point {
  x: number;
  y: number;
}

const PIXELS_PER_SECOND = 90;
const ROW_HEIGHT = 12;
const HEADER_HEIGHT = 28;
const DRUM_NOTE_MINIMUM_WIDTH = 14;
const PITCHED_NOTE_MINIMUM_WIDTH = 3;
const MINIMUM_HORIZONTAL_ZOOM = 0.25;
const MAXIMUM_HORIZONTAL_ZOOM = 4;
const MINIMUM_VERTICAL_ZOOM = 0.5;
const MAXIMUM_VERTICAL_ZOOM = 3;
const DRUM_NAMES: Record<number, string> = {
  35: "Acoustic Bass Drum",
  36: "Bass Drum 1",
  38: "Acoustic Snare",
  40: "Electric Snare",
  42: "Closed Hi-Hat",
  44: "Pedal Hi-Hat",
  46: "Open Hi-Hat",
  41: "Low Floor Tom",
  43: "High Floor Tom",
  45: "Low Tom",
  47: "Low-Mid Tom",
  48: "Hi-Mid Tom",
  50: "High Tom",
  49: "Crash Cymbal 1",
  51: "Ride Cymbal 1",
  57: "Crash Cymbal 2",
  59: "Ride Cymbal 2",
};

export function PianoRollCanvas({
  notes,
  tracks,
  durationSec,
  horizontalZoom,
  verticalZoom,
  bpm,
  beatOffsetSec,
  timeSignature,
  mode,
  selectedNoteIds,
  initialScrollTimeSec,
  playheadSec,
  followPlayhead,
  onSelectionChange,
  onNotePreview,
  onScrollTimeChange,
  onZoomChange,
  onNoteContextMenu,
}: PianoRollCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragStart = useRef<Point | null>(null);
  const dragAdditive = useRef(false);
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
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [selection, setSelection] = useState<Rectangle | null>(null);
  const index = useMemo(() => buildNoteTimeIndex(notes), [notes]);
  const trackColors = useMemo(
    () => new Map(tracks.map((track) => [track.id, track.color])),
    [tracks],
  );
  const pixelsPerSecond = PIXELS_PER_SECOND * horizontalZoom;
  const rowHeight = ROW_HEIGHT * verticalZoom;
  const minimumPitch = mode === "drums" ? 27 : 0;
  const maximumPitch = mode === "drums" ? 87 : 127;
  const minimumNoteWidth =
    mode === "drums"
      ? DRUM_NOTE_MINIMUM_WIDTH
      : PITCHED_NOTE_MINIMUM_WIDTH;
  const contentWidth = Math.max(
    size.width,
    Math.ceil(Math.max(durationSec, 10) * pixelsPerSecond),
  );
  const contentHeight =
    HEADER_HEIGHT + (maximumPitch - minimumPitch + 1) * rowHeight;
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
    }),
    [maximumPitch, pixelsPerSecond, rowHeight, scroll, size],
  );

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
    container.scrollTop = Math.max(
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

    const firstPitch = Math.max(
      minimumPitch,
      maximumPitch - Math.ceil((scroll.top + size.height) / rowHeight),
    );
    const lastPitch = Math.min(
      maximumPitch,
      maximumPitch - Math.floor(scroll.top / rowHeight),
    );
    context.lineWidth = 1;
    for (let pitch = firstPitch; pitch <= lastPitch; pitch += 1) {
      const y =
        HEADER_HEIGHT + (maximumPitch - pitch) * rowHeight - scroll.top;
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
          `${pitch} ${DRUM_NAMES[pitch] ?? "Percussion"}`,
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
        context.fillText(`${line.measureNumber}.1`, x + 4, 12);
        context.fillStyle = "#778397";
        context.font = "9px Consolas";
        context.fillText(`${line.timeSec.toFixed(1)}s`, x + 4, 24);
      } else if (!line.isMeasureStart && beatSpacing >= 32) {
        context.fillStyle = "#8a94a5";
        context.font = "9px Consolas";
        context.fillText(
          `${line.measureNumber}.${line.beatInMeasure}`,
          x + 3,
          18,
        );
      }
    }
    context.strokeStyle = "#343d4d";
    context.beginPath();
    context.moveTo(0, HEADER_HEIGHT - 0.5);
    context.lineTo(size.width, HEADER_HEIGHT - 0.5);
    context.stroke();

    const visibleNotes = findVisibleNotes(
      index,
      Math.max(0, startSec - minimumNoteWidth / pixelsPerSecond),
      endSec,
    );
    for (const note of visibleNotes) {
      const rectangle = noteRectangle(note, viewport, minimumNoteWidth);
      if (
        rectangle.y + rectangle.height < HEADER_HEIGHT ||
        rectangle.y > size.height
      ) {
        continue;
      }
      context.fillStyle = trackColors.get(note.trackId) ?? "#7c6cff";
      context.globalAlpha = selectedNoteIds.has(note.id) ? 1 : 0.82;
      context.fillRect(
        rectangle.x,
        rectangle.y,
        rectangle.width,
        rectangle.height,
      );
      if (selectedNoteIds.has(note.id)) {
        context.strokeStyle = "#ffffff";
        context.lineWidth = 1.5;
        context.strokeRect(
          rectangle.x + 0.5,
          rectangle.y + 0.5,
          Math.max(0, rectangle.width - 1),
          Math.max(0, rectangle.height - 1),
        );
      }
    }
    context.globalAlpha = 1;
    if (selection !== null) {
      context.fillStyle = "rgba(124, 108, 255, 0.18)";
      context.strokeStyle = "#a99fff";
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
    index,
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
    minimumPitch,
    mode,
    minimumNoteWidth,
    playheadSec,
    timeSignature,
  ]);

  function pointFromEvent(
    event:
      | ReactPointerEvent<HTMLCanvasElement>
      | ReactMouseEvent<HTMLCanvasElement>,
  ): Point {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function visibleHit(point: Point): ProjectNote | undefined {
    return noteAtPoint(index, point, viewport, minimumNoteWidth);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) {
      return;
    }
    const point = pointFromEvent(event);
    if (point.y < HEADER_HEIGHT) {
      return;
    }
    const hit = visibleHit(point);
    if (hit !== undefined) {
      const next = event.shiftKey
        ? new Set(selectedNoteIds)
        : new Set<string>();
      next.add(hit.id);
      onSelectionChange(next);
      onNotePreview(hit);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = point;
    dragAdditive.current = event.shiftKey;
    setSelection({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (dragStart.current === null) {
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
    if (finalSelection.width < 3 && finalSelection.height < 3) {
      onSelectionChange(new Set());
    } else {
      const intersecting = notesIntersectingRectangle(
        index,
        finalSelection,
        viewport,
        minimumNoteWidth,
      );
      const next = dragAdditive.current
        ? new Set(selectedNoteIds)
        : new Set<string>();
      intersecting.forEach((note) => next.add(note.id));
      onSelectionChange(next);
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

  function handleContextMenu(event: ReactMouseEvent<HTMLCanvasElement>) {
    event.preventDefault();
    const point = pointFromEvent(event);
    const hit = visibleHit(point);
    if (hit === undefined) {
      return;
    }
    if (!selectedNoteIds.has(hit.id)) {
      onSelectionChange(new Set([hit.id]));
    }
    onNoteContextMenu(hit.id, point);
  }

  return (
    <div
      className="piano-roll-viewport"
      ref={containerRef}
      onScroll={handleScroll}
      aria-label={mode === "drums" ? "ドラムロール" : "統合ピアノロール"}
    >
      <div
        className="piano-roll-content"
        style={{ width: contentWidth, height: contentHeight }}
      >
        <canvas
          className="piano-roll-canvas"
          ref={canvasRef}
          style={{ left: scroll.left, top: scroll.top }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishSelection}
          onPointerCancel={finishSelection}
          onContextMenu={handleContextMenu}
        />
      </div>
    </div>
  );
}
