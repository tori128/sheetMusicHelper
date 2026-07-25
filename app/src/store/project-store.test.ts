import { describe, expect, it, vi } from "vitest";
import type {
  AudioInfo,
  InstrumentDefinition,
  PresetDefinition,
} from "../types";
import { ProjectStore } from "./project-store";

const audio: AudioInfo = {
  absolutePath: "D:\\music\\song.wav",
  sha256: "a".repeat(64),
  durationSec: 90,
  sampleRate: 44100,
  channels: 2,
  codecName: "pcm_f32le",
};

const instruments: InstrumentDefinition[] = [
  {
    id: "acoustic_piano",
    displayNameJa: "ピアノ",
    kind: "pitched",
    gmProgram: 0,
  },
  {
    id: "electric_bass",
    displayNameJa: "ベース",
    kind: "pitched",
    gmProgram: 33,
  },
  {
    id: "drums",
    displayNameJa: "ドラム",
    kind: "drums",
    gmProgram: null,
  },
];

const preset: PresetDefinition = {
  id: "preset-1",
  key: "test",
  name: "テスト編成",
  trackCount: 3,
  tracks: [
    {
      displayName: "Piano",
      instrumentId: "acoustic_piano",
      color: "#4C9AFF",
      kind: "pitched",
      order: 1,
    },
    {
      displayName: "Bass",
      instrumentId: "electric_bass",
      color: "#7A5AF8",
      kind: "pitched",
      order: 2,
    },
    {
      displayName: "Drums",
      instrumentId: "drums",
      color: "#FFAB00",
      kind: "drums",
      order: 3,
    },
  ],
};

function createStore() {
  let sequence = 0;
  return new ProjectStore(() => `id-${++sequence}`);
}

describe("ProjectStore", () => {
  it("creates an ecaproj-compatible document from a preset", () => {
    const store = createStore();

    store.createProject({
      name: "  song  ",
      audio,
      bpm: 123.4,
      numerator: 6,
      denominator: 8,
      preset,
      instruments,
    });

    const state = store.getSnapshot();
    expect(state.screen).toBe("editor");
    expect(state.project).toMatchObject({
      formatVersion: 1,
      projectId: "id-4",
      name: "song",
      sourceAudio: {
        absolutePath: audio.absolutePath,
        sha256: audio.sha256,
      },
      tempo: {
        bpm: 123.4,
        timeSignature: { numerator: 6, denominator: 8 },
        ppq: 480,
      },
    });
    expect(state.project?.tracks.map((track) => track.midiChannel)).toEqual([
      1, 2, 10,
    ]);
    expect(state.project?.tracks.map((track) => track.gmProgram)).toEqual([
      0, 33, null,
    ]);
  });

  it("updates mute and solo immutably and notifies subscribers", () => {
    const store = createStore();
    store.createProject({
      name: "song",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    const listener = vi.fn();
    store.subscribe(listener);
    const previous = store.getSnapshot().project;
    const trackId = previous!.tracks[0].id;

    store.toggleMute(trackId);
    store.toggleSolo(trackId);

    const current = store.getSnapshot().project;
    expect(current).not.toBe(previous);
    expect(current?.tracks[0]).toMatchObject({ mute: true, solo: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rejects a BPM outside the project range", () => {
    const store = createStore();

    expect(() =>
      store.createProject({
        name: "song",
        audio,
        bpm: 301,
        numerator: 4,
        denominator: 4,
        preset,
        instruments,
      }),
    ).toThrow("20.0〜300.0");
  });

  it("ingests streaming notes in time order and maintains selection", () => {
    const store = createStore();
    store.createProject({
      name: "song",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    const trackId = store.getSnapshot().project!.tracks[0].id;
    store.beginJob("job-1");
    store.applyJobEvent({
      type: "progress",
      stage: "transcribing",
      completed: 1,
      total: 4,
    });
    store.applyJobEvent({
      type: "note",
      id: "note-late",
      sourceInstrumentId: "acoustic_piano",
      trackId,
      pitch: 64,
      rawStartSec: 2,
      rawEndSec: 2.5,
      startSec: 2,
      endSec: 2.5,
      velocity: 100,
    });
    store.applyJobEvent({
      type: "note",
      id: "note-early",
      sourceInstrumentId: "acoustic_piano",
      trackId,
      pitch: 60,
      rawStartSec: 1,
      rawEndSec: 1.5,
      startSec: 1,
      endSec: 1.5,
      velocity: 100,
    });

    store.toggleNoteSelection("note-early", false);
    store.toggleNoteSelection("note-late", true);

    const state = store.getSnapshot();
    expect(state.job).toMatchObject({
      id: "job-1",
      status: "transcribing",
      completed: 1,
      total: 4,
    });
    expect(state.project?.notes.map((note) => note.id)).toEqual([
      "note-early",
      "note-late",
    ]);
    expect([...state.selectedNoteIds]).toEqual(["note-early", "note-late"]);
  });

  it("reopens a saved document with notes sorted and no active selection", () => {
    const source = createStore();
    source.createProject({
      name: "song",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    const document = source.getSnapshot().project!;
    const firstTrack = document.tracks[0].id;
    const reopened = createStore();

    reopened.openProject(
      {
        ...document,
        notes: [
          {
            id: "late",
            sourceInstrumentId: "acoustic_piano",
            trackId: firstTrack,
            pitch: 64,
            rawStartSec: 2,
            rawEndSec: 3,
            startSec: 2,
            endSec: 3,
            velocity: 100,
          },
          {
            id: "early",
            sourceInstrumentId: "acoustic_piano",
            trackId: firstTrack,
            pitch: 60,
            rawStartSec: 1,
            rawEndSec: 1.5,
            startSec: 1,
            endSec: 1.5,
            velocity: 100,
          },
        ],
      },
      null,
    );

    expect(reopened.getSnapshot().screen).toBe("editor");
    expect(reopened.getSnapshot().project?.notes.map((note) => note.id)).toEqual(
      ["early", "late"],
    );
    expect(reopened.getSnapshot().selectedNoteIds.size).toBe(0);
  });

  it("stores four-stem mode and ingests separated stem metadata", () => {
    const store = createStore();
    store.createProject({
      name: "song",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
      mode: "four_stem",
    });
    store.beginJob("job-stems");

    store.applyJobEvent({
      type: "stem",
      stem: {
        type: "drums",
        cachePath: "D:\\cache\\drums.wav",
        sha256: "d".repeat(64),
        sampleRate: 44100,
        channels: 2,
      },
    });

    expect(store.getSnapshot().transcriptionMode).toBe("four_stem");
    expect(store.getSnapshot().project?.stems).toEqual([
      expect.objectContaining({
        type: "drums",
        cachePath: "D:\\cache\\drums.wav",
      }),
    ]);
  });

  it("stores analyzed beat phase and adjusts every note endpoint", () => {
    const store = createStore();
    store.createProject({
      name: "song",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    const trackId = store.getSnapshot().project!.tracks[0].id;
    store.beginJob("timing");
    store.applyJobEvent({
      type: "note",
      id: "timing-note",
      sourceInstrumentId: "acoustic_piano",
      trackId,
      pitch: 60,
      rawStartSec: 0.34,
      rawEndSec: 0.57,
      startSec: 0.34,
      endSec: 0.57,
      velocity: 100,
    });

    store.setTempoAnalysis(120, 0.1);
    store.quantizeAll("1/8");
    expect(store.getSnapshot().project?.notes[0].startSec).toBeCloseTo(0.35);
    expect(store.getSnapshot().project?.notes[0].endSec).toBeCloseTo(0.6);

    store.shiftAllNotes(-0.05);
    expect(store.getSnapshot().project?.notes[0].startSec).toBeCloseTo(0.3);
    expect(store.getSnapshot().project?.notes[0].endSec).toBeCloseTo(0.55);
    expect(store.getSnapshot().project?.notes[0].rawStartSec).toBe(0.34);
    expect(store.getSnapshot().project?.tempo.beatOffsetSec).toBe(0.1);
  });

  it("uses the selected note as a repeating measure boundary", () => {
    const store = createStore();
    store.createProject({
      name: "measure phase",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    const trackId = store.getSnapshot().project!.tracks[0].id;
    store.beginJob("measure-phase");
    store.applyJobEvent({
      type: "note",
      id: "measure-start",
      sourceInstrumentId: "acoustic_piano",
      trackId,
      pitch: 60,
      rawStartSec: 5.25,
      rawEndSec: 5.5,
      startSec: 5.25,
      endSec: 5.5,
      velocity: 100,
    });
    store.setSelection(["measure-start"]);

    store.setSelectedNoteAsMeasureStart();

    expect(store.getSnapshot().project?.tempo.bpm).toBe(120);
    expect(store.getSnapshot().project?.tempo.beatOffsetSec).toBeCloseTo(1.25);
    expect(store.getSnapshot().selectedNoteIds).toEqual(
      new Set(["measure-start"]),
    );
  });
});
