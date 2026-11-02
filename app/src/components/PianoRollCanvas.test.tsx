import { fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectNote, ProjectTrack } from "../types";
import { PianoRollCanvas } from "./PianoRollCanvas";

const track: ProjectTrack = {
  id: "piano",
  displayName: "Piano",
  instrumentId: "acoustic_piano",
  kind: "pitched",
  color: "#4c9aff",
  order: 1,
  midiChannel: 1,
  gmProgram: 0,
  playbackOctaveShift: 0,
  playbackVolume: 100,
  mute: false,
  solo: false,
};

const TOP_NOTE_Y = 50;

const note: ProjectNote = {
  id: "note",
  sourceInstrumentId: "acoustic_piano",
  trackId: track.id,
  pitch: 127,
  rawStartSec: 0,
  rawEndSec: 1,
  startSec: 0,
  endSec: 1,
  velocity: 100,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("previews a note until release and stops it if the window loses focus", () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, eventInit: PointerEventInit = {}) {
        super(type, eventInit);
        this.pointerId = eventInit.pointerId ?? 0;
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const onNotePreviewStart = vi.fn();
  const onNotePreviewEnd = vi.fn();
  const onMoveNotes = vi.fn();
  const { container } = render(
    <PianoRollCanvas
      notes={[note]}
      tracks={[track]}
      durationSec={10}
      horizontalZoom={1}
      verticalZoom={1}
      bpm={120}
      beatOffsetSec={0}
      timeSignature={{ numerator: 4, denominator: 4 }}
      chordSpans={[]}
      mode="pitched"
      selectedNoteIds={new Set()}
      initialScrollTimeSec={0}
      playheadSec={0}
      followPlayhead={false}
      editingLocked={false}
      tool="select"
      quantizeGrid="1/16"
      editTargetTrackId={track.id}
      onSelectionChange={vi.fn()}
      onNotePreviewStart={onNotePreviewStart}
      onNotePreviewEnd={onNotePreviewEnd}
      onMoveNotes={onMoveNotes}
      onResizeNote={vi.fn()}
      onCreateNote={vi.fn()}
      onDeleteNotes={vi.fn()}
      onSeek={vi.fn()}
      onScrollTimeChange={vi.fn()}
      onZoomChange={vi.fn()}
    />,
  );
  const canvas = container.querySelector("canvas")!;
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn(() => true);
  canvas.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId: 7,
    clientX: 10,
    clientY: TOP_NOTE_Y,
  });

  expect(onNotePreviewStart).toHaveBeenCalledWith(note);
  expect(onNotePreviewEnd).not.toHaveBeenCalled();
  expect(canvas.setPointerCapture).toHaveBeenCalledWith(7);

  fireEvent.pointerMove(canvas, {
    buttons: 1,
    pointerId: 7,
    clientX: 200,
    clientY: 206,
  });
  expect(onNotePreviewEnd).not.toHaveBeenCalled();
  expect(onNotePreviewStart).toHaveBeenLastCalledWith(
    expect.objectContaining({ pitch: 114 }),
  );

  fireEvent.pointerUp(canvas, {
    button: 0,
    pointerId: 7,
    clientX: 200,
    clientY: 206,
  });

  expect(onNotePreviewEnd).toHaveBeenCalledWith(false);
  expect(onMoveNotes).toHaveBeenCalledWith(2.125, -13);
  expect(canvas.releasePointerCapture).toHaveBeenCalledWith(7);

  onNotePreviewEnd.mockClear();
  onMoveNotes.mockClear();
  canvas.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId: 8,
    clientX: 10,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.pointerMove(canvas, {
    buttons: 1,
    pointerId: 8,
    clientX: 100,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.blur(window);

  expect(onNotePreviewEnd).toHaveBeenCalledWith(true);
  expect(onMoveNotes).not.toHaveBeenCalled();
  expect(canvas.releasePointerCapture).toHaveBeenCalledWith(8);
});

it("blocks note geometry editing while locked and ignores right clicks", () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, eventInit: PointerEventInit = {}) {
        super(type, eventInit);
        this.pointerId = eventInit.pointerId ?? 0;
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const onSelectionChange = vi.fn();
  const onNotePreviewStart = vi.fn();
  const onNotePreviewEnd = vi.fn();
  const onMoveNotes = vi.fn();
  const onResizeNote = vi.fn();
  const { container } = render(
    <PianoRollCanvas
      notes={[note]}
      tracks={[track]}
      durationSec={10}
      horizontalZoom={1}
      verticalZoom={1}
      bpm={120}
      beatOffsetSec={0}
      timeSignature={{ numerator: 4, denominator: 4 }}
      chordSpans={[]}
      mode="pitched"
      selectedNoteIds={new Set()}
      initialScrollTimeSec={0}
      playheadSec={0}
      followPlayhead={false}
      editingLocked
      tool="select"
      quantizeGrid="1/16"
      editTargetTrackId={track.id}
      onSelectionChange={onSelectionChange}
      onNotePreviewStart={onNotePreviewStart}
      onNotePreviewEnd={onNotePreviewEnd}
      onMoveNotes={onMoveNotes}
      onResizeNote={onResizeNote}
      onCreateNote={vi.fn()}
      onDeleteNotes={vi.fn()}
      onSeek={vi.fn()}
      onScrollTimeChange={vi.fn()}
      onZoomChange={vi.fn()}
    />,
  );
  const viewport = container.querySelector(".piano-roll-viewport")!;
  const canvas = container.querySelector("canvas")!;
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn(() => true);
  canvas.releasePointerCapture = vi.fn();

  expect(viewport).toHaveAttribute("aria-readonly", "true");
  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId: 10,
    clientX: 10,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.pointerMove(canvas, {
    buttons: 1,
    pointerId: 10,
    clientX: 200,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.pointerUp(canvas, {
    button: 0,
    pointerId: 10,
    clientX: 200,
    clientY: TOP_NOTE_Y,
  });
  const contextMenuEvent = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 10,
    clientY: TOP_NOTE_Y,
  });
  fireEvent(canvas, contextMenuEvent);

  expect(onSelectionChange).toHaveBeenCalledWith(new Set(["note"]));
  expect(onSelectionChange).toHaveBeenCalledTimes(1);
  expect(contextMenuEvent.defaultPrevented).toBe(true);
  expect(onNotePreviewStart).toHaveBeenCalledWith(note);
  expect(onNotePreviewEnd).toHaveBeenCalledWith(false);
  expect(onMoveNotes).not.toHaveBeenCalled();
  expect(onResizeNote).not.toHaveBeenCalled();
});

it("resizes a selected note from the handle immediately after its right edge", () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, eventInit: PointerEventInit = {}) {
        super(type, eventInit);
        this.pointerId = eventInit.pointerId ?? 0;
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const onResizeNote = vi.fn();
  const onNotePreviewStart = vi.fn();
  const { container } = render(
    <PianoRollCanvas
      notes={[note]}
      tracks={[track]}
      durationSec={10}
      horizontalZoom={1}
      verticalZoom={1}
      bpm={120}
      beatOffsetSec={0}
      timeSignature={{ numerator: 4, denominator: 4 }}
      chordSpans={[]}
      mode="pitched"
      selectedNoteIds={new Set(["note"])}
      initialScrollTimeSec={0}
      playheadSec={0}
      followPlayhead={false}
      editingLocked={false}
      tool="select"
      quantizeGrid="1/16"
      editTargetTrackId={track.id}
      onSelectionChange={vi.fn()}
      onNotePreviewStart={onNotePreviewStart}
      onNotePreviewEnd={vi.fn()}
      onMoveNotes={vi.fn()}
      onResizeNote={onResizeNote}
      onCreateNote={vi.fn()}
      onDeleteNotes={vi.fn()}
      onSeek={vi.fn()}
      onScrollTimeChange={vi.fn()}
      onZoomChange={vi.fn()}
    />,
  );
  const canvas = container.querySelector("canvas")!;
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn(() => true);
  canvas.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId: 9,
    clientX: 92,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.pointerMove(canvas, {
    buttons: 1,
    pointerId: 9,
    clientX: 134,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.pointerUp(canvas, {
    button: 0,
    pointerId: 9,
    clientX: 134,
    clientY: TOP_NOTE_Y,
  });

  expect(onResizeNote).toHaveBeenCalledWith("note", 1.5);
  expect(onNotePreviewStart).not.toHaveBeenCalled();
});

it("resizes a selected note from its left edge", () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, eventInit: PointerEventInit = {}) {
        super(type, eventInit);
        this.pointerId = eventInit.pointerId ?? 0;
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const onResizeNoteStart = vi.fn();
  const { container } = render(
    <PianoRollCanvas
      notes={[note]}
      tracks={[track]}
      durationSec={10}
      horizontalZoom={1}
      verticalZoom={1}
      bpm={120}
      beatOffsetSec={0}
      timeSignature={{ numerator: 4, denominator: 4 }}
      chordSpans={[]}
      mode="pitched"
      selectedNoteIds={new Set(["note"])}
      initialScrollTimeSec={0}
      playheadSec={0}
      followPlayhead={false}
      editingLocked={false}
      tool="select"
      quantizeGrid="1/16"
      editTargetTrackId={track.id}
      onSelectionChange={vi.fn()}
      onNotePreviewStart={vi.fn()}
      onNotePreviewEnd={vi.fn()}
      onMoveNotes={vi.fn()}
      onResizeNoteStart={onResizeNoteStart}
      onResizeNote={vi.fn()}
      onCreateNote={vi.fn()}
      onDeleteNotes={vi.fn()}
      onSeek={vi.fn()}
      onScrollTimeChange={vi.fn()}
      onZoomChange={vi.fn()}
    />,
  );
  const canvas = container.querySelector("canvas")!;
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn(() => true);
  canvas.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId: 10,
    clientX: 2,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.pointerMove(canvas, {
    buttons: 1,
    pointerId: 10,
    clientX: 46,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.pointerUp(canvas, {
    button: 0,
    pointerId: 10,
    clientX: 46,
    clientY: TOP_NOTE_Y,
  });

  expect(onResizeNoteStart).toHaveBeenCalledWith("note", 0.5);
});

it("creates a one-grid note in the selected edit target track", () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, eventInit: PointerEventInit = {}) {
        super(type, eventInit);
        this.pointerId = eventInit.pointerId ?? 0;
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const onCreateNote = vi.fn();
  const onNotePreviewStart = vi.fn();
  const onNotePreviewEnd = vi.fn();
  const targetTrack: ProjectTrack = {
    ...track,
    id: "strings",
    displayName: "Strings",
    instrumentId: "strings",
    order: 2,
  };
  const { container } = render(
    <PianoRollCanvas
      notes={[note]}
      tracks={[track, targetTrack]}
      durationSec={10}
      horizontalZoom={1}
      verticalZoom={1}
      bpm={120}
      beatOffsetSec={0}
      timeSignature={{ numerator: 4, denominator: 4 }}
      chordSpans={[]}
      mode="pitched"
      selectedNoteIds={new Set()}
      initialScrollTimeSec={0}
      playheadSec={0}
      followPlayhead={false}
      editingLocked
      tool="draw"
      quantizeGrid="1/16"
      editTargetTrackId={targetTrack.id}
      onSelectionChange={vi.fn()}
      onNotePreviewStart={onNotePreviewStart}
      onNotePreviewEnd={onNotePreviewEnd}
      onMoveNotes={vi.fn()}
      onResizeNote={vi.fn()}
      onCreateNote={onCreateNote}
      onDeleteNotes={vi.fn()}
      onSeek={vi.fn()}
      onScrollTimeChange={vi.fn()}
      onZoomChange={vi.fn()}
    />,
  );
  const canvas = container.querySelector("canvas")!;
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn(() => true);
  canvas.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId: 12,
    clientX: 100,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.pointerUp(canvas, {
    button: 0,
    pointerId: 12,
    clientX: 100,
    clientY: TOP_NOTE_Y,
  });

  expect(onCreateNote).toHaveBeenCalledWith({
    trackId: targetTrack.id,
    pitch: 127,
    startSec: 1.125,
    endSec: 1.25,
  });
  expect(onNotePreviewStart).toHaveBeenCalledWith(
    expect.objectContaining({ pitch: 127, startSec: 1.125 }),
  );
  expect(onNotePreviewEnd).toHaveBeenCalledWith(false);
});

it("selects and moves an existing note while using the draw tool", () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, eventInit: PointerEventInit = {}) {
        super(type, eventInit);
        this.pointerId = eventInit.pointerId ?? 0;
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const onSelectionChange = vi.fn();
  const onMoveNotes = vi.fn();
  const onCreateNote = vi.fn();
  const { container } = render(
    <PianoRollCanvas
      notes={[note]}
      tracks={[track]}
      durationSec={10}
      horizontalZoom={1}
      verticalZoom={1}
      bpm={120}
      beatOffsetSec={0}
      timeSignature={{ numerator: 4, denominator: 4 }}
      chordSpans={[]}
      mode="pitched"
      selectedNoteIds={new Set()}
      initialScrollTimeSec={0}
      playheadSec={0}
      followPlayhead={false}
      editingLocked={false}
      tool="draw"
      quantizeGrid="1/16"
      editTargetTrackId={track.id}
      onSelectionChange={onSelectionChange}
      onNotePreviewStart={vi.fn()}
      onNotePreviewEnd={vi.fn()}
      onMoveNotes={onMoveNotes}
      onResizeNote={vi.fn()}
      onCreateNote={onCreateNote}
      onDeleteNotes={vi.fn()}
      onSeek={vi.fn()}
      onScrollTimeChange={vi.fn()}
      onZoomChange={vi.fn()}
    />,
  );
  const canvas = container.querySelector("canvas")!;
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn(() => true);
  canvas.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId: 13,
    clientX: 20,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.pointerMove(canvas, {
    buttons: 1,
    pointerId: 13,
    clientX: 65,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.pointerUp(canvas, {
    button: 0,
    pointerId: 13,
    clientX: 65,
    clientY: TOP_NOTE_Y,
  });

  expect(onSelectionChange).toHaveBeenCalledWith(new Set(["note"]));
  expect(onMoveNotes).toHaveBeenCalledOnce();
  expect(onMoveNotes.mock.calls[0][0]).toBe(0.5);
  expect(onMoveNotes.mock.calls[0][1]).toBeCloseTo(0);
  expect(onCreateNote).not.toHaveBeenCalled();
});

it("resizes an existing note while using the draw tool", () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, eventInit: PointerEventInit = {}) {
        super(type, eventInit);
        this.pointerId = eventInit.pointerId ?? 0;
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const onResizeNote = vi.fn();
  const onCreateNote = vi.fn();
  const { container } = render(
    <PianoRollCanvas
      notes={[note]}
      tracks={[track]}
      durationSec={10}
      horizontalZoom={1}
      verticalZoom={1}
      bpm={120}
      beatOffsetSec={0}
      timeSignature={{ numerator: 4, denominator: 4 }}
      chordSpans={[]}
      mode="pitched"
      selectedNoteIds={new Set(["note"])}
      initialScrollTimeSec={0}
      playheadSec={0}
      followPlayhead={false}
      editingLocked={false}
      tool="draw"
      quantizeGrid="1/16"
      editTargetTrackId={track.id}
      onSelectionChange={vi.fn()}
      onNotePreviewStart={vi.fn()}
      onNotePreviewEnd={vi.fn()}
      onMoveNotes={vi.fn()}
      onResizeNote={onResizeNote}
      onCreateNote={onCreateNote}
      onDeleteNotes={vi.fn()}
      onSeek={vi.fn()}
      onScrollTimeChange={vi.fn()}
      onZoomChange={vi.fn()}
    />,
  );
  const canvas = container.querySelector("canvas")!;
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn(() => true);
  canvas.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId: 14,
    clientX: 92,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.pointerMove(canvas, {
    buttons: 1,
    pointerId: 14,
    clientX: 134,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.pointerUp(canvas, {
    button: 0,
    pointerId: 14,
    clientX: 134,
    clientY: TOP_NOTE_Y,
  });

  expect(onResizeNote).toHaveBeenCalledWith("note", 1.5);
  expect(onCreateNote).not.toHaveBeenCalled();
});

it("deletes every note intersecting an eraser rectangle", () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, eventInit: PointerEventInit = {}) {
        super(type, eventInit);
        this.pointerId = eventInit.pointerId ?? 0;
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const secondNote: ProjectNote = {
    ...note,
    id: "second-note",
    pitch: 126,
    startSec: 1.2,
    endSec: 1.8,
  };
  const onDeleteNotes = vi.fn();
  const { container } = render(
    <PianoRollCanvas
      notes={[note, secondNote]}
      tracks={[track]}
      durationSec={10}
      horizontalZoom={1}
      verticalZoom={1}
      bpm={120}
      beatOffsetSec={0}
      timeSignature={{ numerator: 4, denominator: 4 }}
      chordSpans={[]}
      mode="pitched"
      selectedNoteIds={new Set()}
      initialScrollTimeSec={0}
      playheadSec={0}
      followPlayhead={false}
      editingLocked={false}
      tool="erase"
      quantizeGrid="1/16"
      editTargetTrackId={track.id}
      onSelectionChange={vi.fn()}
      onNotePreviewStart={vi.fn()}
      onNotePreviewEnd={vi.fn()}
      onMoveNotes={vi.fn()}
      onResizeNote={vi.fn()}
      onCreateNote={vi.fn()}
      onDeleteNotes={onDeleteNotes}
      onSeek={vi.fn()}
      onScrollTimeChange={vi.fn()}
      onZoomChange={vi.fn()}
    />,
  );
  const canvas = container.querySelector("canvas")!;
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn(() => true);
  canvas.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId: 14,
    clientX: 10,
    clientY: TOP_NOTE_Y,
  });
  fireEvent.pointerUp(canvas, {
    button: 0,
    pointerId: 14,
    clientX: 10,
    clientY: TOP_NOTE_Y,
  });
  expect(onDeleteNotes).toHaveBeenCalledWith(new Set(["note"]));
  onDeleteNotes.mockClear();

  fireEvent.pointerDown(canvas, {
    button: 0,
    pointerId: 13,
    clientX: 0,
    clientY: 48,
  });
  fireEvent.pointerMove(canvas, {
    buttons: 1,
    pointerId: 13,
    clientX: 180,
    clientY: 70,
  });
  fireEvent.pointerUp(canvas, {
    button: 0,
    pointerId: 13,
    clientX: 180,
    clientY: 70,
  });

  expect(onDeleteNotes).toHaveBeenCalledWith(
    new Set(["note", "second-note"]),
  );
});

it("draws integer measure numbers and estimated chord labels", () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, eventInit: PointerEventInit = {}) {
        super(type, eventInit);
        this.pointerId = eventInit.pointerId ?? 0;
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const fillText = vi.fn();
  const onSeek = vi.fn();
  const context = {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText,
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);

  const { container } = render(
    <PianoRollCanvas
      notes={[]}
      tracks={[track]}
      durationSec={10}
      horizontalZoom={1}
      verticalZoom={1}
      bpm={120}
      beatOffsetSec={0.1}
      timeSignature={{ numerator: 4, denominator: 4 }}
      chordSpans={[
        {
          measureNumber: 1,
          startBeat: 1,
          beatLength: 2,
          startSec: 0.1,
          endSec: 1.1,
          label: "C",
        },
      ]}
      mode="pitched"
      selectedNoteIds={new Set()}
      initialScrollTimeSec={0}
      playheadSec={0}
      followPlayhead={false}
      editingLocked={false}
      tool="select"
      quantizeGrid="1/16"
      editTargetTrackId={track.id}
      onSelectionChange={vi.fn()}
      onNotePreviewStart={vi.fn()}
      onNotePreviewEnd={vi.fn()}
      onMoveNotes={vi.fn()}
      onResizeNote={vi.fn()}
      onCreateNote={vi.fn()}
      onDeleteNotes={vi.fn()}
      onSeek={onSeek}
      onScrollTimeChange={vi.fn()}
      onZoomChange={vi.fn()}
    />,
  );

  expect(fillText.mock.calls.some(([text]) => text === "1")).toBe(true);
  expect(fillText.mock.calls.some(([text]) => text === "1.1")).toBe(false);
  expect(fillText.mock.calls.some(([text]) => text === "C")).toBe(true);
  const measureLabel = fillText.mock.calls.find(([text]) => text === "1");
  const chordLabel = fillText.mock.calls.find(([text]) => text === "C");
  expect(chordLabel?.[2]).toBeLessThan(measureLabel?.[2] as number);
  const canvas = container.querySelector("canvas")!;
  fireEvent.pointerDown(canvas, {
    button: 0,
    clientX: 126,
    clientY: 30,
  });
  expect(onSeek).toHaveBeenCalledOnce();
  expect(onSeek.mock.calls[0][0]).toBeCloseTo(1.1);
});

it("draws beat-level spectral differences and exposes the numeric value", () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, eventInit: PointerEventInit = {}) {
        super(type, eventInit);
        this.pointerId = eventInit.pointerId ?? 0;
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const fillRect = vi.fn();
  const fillStyles: string[] = [];
  const context = {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    fillRect,
    fillText: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    set fillStyle(value: string) {
      fillStyles.push(value);
    },
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);

  const { container } = render(
    <PianoRollCanvas
      notes={[]}
      tracks={[track]}
      durationSec={10}
      horizontalZoom={1}
      verticalZoom={1}
      bpm={120}
      beatOffsetSec={0}
      timeSignature={{ numerator: 4, denominator: 4 }}
      chordSpans={[]}
      spectralDifferences={[
        {
          startSec: 0,
          endSec: 0.5,
          measureNumber: 1,
          beatInMeasure: 1,
          value: 0.25,
        },
        {
          startSec: 0.5,
          endSec: 1,
          measureNumber: 1,
          beatInMeasure: 2,
          value: 0.75,
        },
      ]}
      mode="pitched"
      selectedNoteIds={new Set()}
      initialScrollTimeSec={0}
      playheadSec={0}
      followPlayhead={false}
      editingLocked={false}
      tool="select"
      quantizeGrid="1/16"
      editTargetTrackId={track.id}
      onSelectionChange={vi.fn()}
      onNotePreviewStart={vi.fn()}
      onNotePreviewEnd={vi.fn()}
      onMoveNotes={vi.fn()}
      onResizeNote={vi.fn()}
      onCreateNote={vi.fn()}
      onDeleteNotes={vi.fn()}
      onSeek={vi.fn()}
      onScrollTimeChange={vi.fn()}
      onZoomChange={vi.fn()}
    />,
  );

  expect(
    fillRect.mock.calls.some(
      ([, y, , height]) => y === 18 && height === 4,
    ),
  ).toBe(true);
  expect(fillStyles).toContain("#37a674");
  expect(fillStyles).toContain("#d64b4b");
  const canvas = container.querySelector("canvas")!;
  fireEvent.pointerMove(canvas, { clientX: 10, clientY: 19 });
  expect(canvas.title).toBe("原音との差 0.250（1.1）");
});

it("renders a two-pixel gap between adjacent notes at the same pitch", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const fillRect = vi.fn();
  const context = {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    fillRect,
    fillText: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  const adjacentNote: ProjectNote = {
    ...note,
    id: "adjacent-note",
    rawStartSec: 1,
    rawEndSec: 2,
    startSec: 1,
    endSec: 2,
  };

  render(
    <PianoRollCanvas
      notes={[note, adjacentNote]}
      tracks={[track]}
      durationSec={10}
      horizontalZoom={1}
      verticalZoom={1}
      bpm={120}
      beatOffsetSec={0}
      timeSignature={{ numerator: 4, denominator: 4 }}
      chordSpans={[]}
      mode="pitched"
      selectedNoteIds={new Set()}
      initialScrollTimeSec={0}
      playheadSec={0}
      followPlayhead={false}
      editingLocked={false}
      tool="select"
      quantizeGrid="1/16"
      editTargetTrackId={track.id}
      onSelectionChange={vi.fn()}
      onNotePreviewStart={vi.fn()}
      onNotePreviewEnd={vi.fn()}
      onMoveNotes={vi.fn()}
      onResizeNote={vi.fn()}
      onCreateNote={vi.fn()}
      onDeleteNotes={vi.fn()}
      onSeek={vi.fn()}
      onScrollTimeChange={vi.fn()}
      onZoomChange={vi.fn()}
    />,
  );

  const noteRectangles = fillRect.mock.calls.filter(
    ([, y, , height]) => y === 48 && height === 11,
  );
  expect(noteRectangles).toContainEqual([0, 48, 88, 11]);
  expect(noteRectangles).toContainEqual([90, 48, 90, 11]);
});

it("draws larger dedicated rows for the standard drum lanes", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const fillRect = vi.fn();
  const context = {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    fillRect,
    fillText: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  const drumTrack: ProjectTrack = {
    ...track,
    id: "drums",
    displayName: "Drums",
    instrumentId: "drums",
    kind: "drums",
    midiChannel: 10,
    gmProgram: null,
  };
  const drumNote = (id: string, pitch: number): ProjectNote => ({
    ...note,
    id,
    sourceInstrumentId: "drums",
    trackId: drumTrack.id,
    pitch,
  });

  const { container } = render(
    <PianoRollCanvas
      notes={[
        drumNote("kick", 36),
        drumNote("hand-clap", 39),
        drumNote("open-triangle", 81),
        drumNote("non-gm", 82),
      ]}
      tracks={[drumTrack]}
      durationSec={10}
      horizontalZoom={1}
      verticalZoom={1}
      bpm={120}
      beatOffsetSec={0}
      timeSignature={{ numerator: 4, denominator: 4 }}
      chordSpans={[]}
      mode="drums"
      selectedNoteIds={new Set()}
      initialScrollTimeSec={0}
      playheadSec={0}
      followPlayhead={false}
      editingLocked={false}
      tool="select"
      quantizeGrid="1/16"
      editTargetTrackId={track.id}
      onSelectionChange={vi.fn()}
      onNotePreviewStart={vi.fn()}
      onNotePreviewEnd={vi.fn()}
      onMoveNotes={vi.fn()}
      onResizeNote={vi.fn()}
      onCreateNote={vi.fn()}
      onDeleteNotes={vi.fn()}
      onSeek={vi.fn()}
      onScrollTimeChange={vi.fn()}
      onZoomChange={vi.fn()}
    />,
  );

  const content = container.querySelector<HTMLDivElement>(
    ".piano-roll-content",
  );
  expect(content?.style.height).toBe("390px");
  expect(
    fillRect.mock.calls.filter(([, y]) => (y as number) >= 48),
  ).toHaveLength(3);
});

it("routes plain, Ctrl, and Shift wheel input to the intended axis", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const onZoomChange = vi.fn();
  const { container } = render(
    <PianoRollCanvas
      notes={[]}
      tracks={[track]}
      durationSec={30}
      horizontalZoom={1}
      verticalZoom={1}
      bpm={120}
      beatOffsetSec={0}
      timeSignature={{ numerator: 4, denominator: 4 }}
      chordSpans={[]}
      mode="pitched"
      selectedNoteIds={new Set()}
      initialScrollTimeSec={0}
      playheadSec={0}
      followPlayhead={false}
      editingLocked={false}
      tool="select"
      quantizeGrid="1/16"
      editTargetTrackId={track.id}
      onSelectionChange={vi.fn()}
      onNotePreviewStart={vi.fn()}
      onNotePreviewEnd={vi.fn()}
      onMoveNotes={vi.fn()}
      onResizeNote={vi.fn()}
      onCreateNote={vi.fn()}
      onDeleteNotes={vi.fn()}
      onSeek={vi.fn()}
      onScrollTimeChange={vi.fn()}
      onZoomChange={onZoomChange}
    />,
  );
  const viewport = container.querySelector<HTMLDivElement>(
    ".piano-roll-viewport",
  )!;
  viewport.scrollLeft = 100;

  expect(
    fireEvent.wheel(viewport, {
      deltaY: 80,
      clientX: 200,
      clientY: 200,
    }),
  ).toBe(false);
  expect(viewport.scrollLeft).toBe(180);
  expect(onZoomChange).not.toHaveBeenCalled();

  fireEvent.wheel(viewport, {
    ctrlKey: true,
    deltaY: -100,
    clientX: 200,
    clientY: 200,
  });
  expect(viewport.scrollLeft).toBe(180);
  expect(onZoomChange).toHaveBeenLastCalledWith(1.15, 1);

  fireEvent.wheel(viewport, {
    shiftKey: true,
    deltaY: -100,
    clientX: 200,
    clientY: 200,
  });
  expect(viewport.scrollLeft).toBe(180);
  expect(onZoomChange).toHaveBeenLastCalledWith(1.15, 1.15);
});
