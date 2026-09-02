import { describe, expect, it, vi } from "vitest";
import type {
  AudioInfo,
  InstrumentDefinition,
  ModelProfile,
  PresetDefinition,
} from "../types";
import {
  isProjectEditingLocked,
  limitAnalysisToPostTranscriptionOption,
  mergeTranscriptionNotes,
  ProjectStore,
} from "./project-store";

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
    gmPrograms: [
      { program: 0, displayNameJa: "グランドピアノ" },
      { program: 1, displayNameJa: "ブライトピアノ" },
    ],
  },
  {
    id: "electric_bass",
    displayNameJa: "ベース",
    kind: "pitched",
    gmProgram: 33,
    gmPrograms: [
      { program: 33, displayNameJa: "フィンガーベース" },
      { program: 34, displayNameJa: "ピックベース" },
    ],
  },
  {
    id: "drums",
    displayNameJa: "ドラム",
    kind: "drums",
    gmProgram: null,
    gmPrograms: [],
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
      gmProgram: 1,
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

const model: ModelProfile = {
  id: "model",
  profileName: "Medium",
  modelPath: "D:\\models\\medium.safetensors",
  fileName: "medium.safetensors",
  sha256: "b".repeat(64),
  variant: "medium",
  dtype: "float16",
  defaultBackend: "CPU",
};

function createStore() {
  let sequence = 0;
  return new ProjectStore(() => `id-${++sequence}`);
}

function completeJobWithPrimaryResult(store: ProjectStore): void {
  store.applyJobEvent({
    type: "transcription_input_result",
    inputName: "direct",
    role: "primary",
    transcriptionPass: "original_audio",
    notes: store.getSnapshot().project?.notes.map((note) => ({ ...note })) ?? [],
  });
  store.applyJobEvent({ type: "state", status: "completed" });
}

describe("ProjectStore", () => {
  it("applies a new analysis while preserving manual note edits", () => {
    const previous = [
      {
        id: "unchanged",
        sourceInstrumentId: "acoustic_piano",
        trackId: "piano",
        pitch: 60,
        rawStartSec: 1,
        rawEndSec: 2,
        startSec: 1,
        endSec: 2,
        velocity: 100,
      },
      {
        id: "edited",
        sourceInstrumentId: "acoustic_piano",
        trackId: "piano",
        pitch: 62,
        rawStartSec: 2,
        rawEndSec: 3,
        startSec: 2,
        endSec: 3,
        velocity: 100,
      },
      {
        id: "deleted",
        sourceInstrumentId: "acoustic_piano",
        trackId: "piano",
        pitch: 64,
        rawStartSec: 3,
        rawEndSec: 4,
        startSec: 3,
        endSec: 4,
        velocity: 100,
      },
    ];
    const edited = { ...previous[1], pitch: 65 };
    const manual = {
      ...previous[0],
      id: "manual",
      pitch: 67,
      startSec: 4,
      endSec: 5,
    };
    const next = [
      { ...previous[0], velocity: 88 },
      { ...previous[1], velocity: 90 },
      { ...previous[2], velocity: 92 },
      {
        ...previous[0],
        id: "new-analysis",
        pitch: 69,
        startSec: 5,
        endSec: 6,
      },
    ];

    const merged = mergeTranscriptionNotes(
      previous,
      [previous[0], edited, manual],
      next,
    );

    expect(merged.map(({ id }) => id)).toEqual([
      "unchanged",
      "edited",
      "manual",
      "new-analysis",
    ]);
    expect(merged.find(({ id }) => id === "unchanged")?.velocity).toBe(88);
    expect(merged.find(({ id }) => id === "edited")?.pitch).toBe(65);
  });

  it("replaces guitar notes when the timing-guide note filter changes", () => {
    const store = createStore();
    store.createProject({
      name: "timing guide scope",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    const project = store.getSnapshot().project!;
    const guitarTrack = {
      ...project.tracks[0],
      id: "guitar-track",
      instrumentId: "acoustic_guitar",
      displayName: "Guitar",
    };
    const vocalTrack = {
      ...project.tracks[0],
      id: "vocal-track",
      instrumentId: "voice",
      displayName: "Vocal",
    };
    const previousGuitar = {
      id: "guitar-before",
      sourceInstrumentId: "acoustic_guitar",
      trackId: guitarTrack.id,
      pitch: 55,
      rawStartSec: 1,
      rawEndSec: 2,
      startSec: 1,
      endSec: 2,
      velocity: 100,
    };
    const previousVocal = {
      ...previousGuitar,
      id: "vocal-before",
      sourceInstrumentId: "voice",
      trackId: vocalTrack.id,
      pitch: 60,
    };

    const limited = limitAnalysisToPostTranscriptionOption(
      [previousGuitar, previousVocal],
      [
        { ...previousGuitar, id: "guitar-after", pitch: 57 },
        { ...previousVocal, id: "vocal-after", pitch: 62 },
      ],
      [...project.tracks, guitarTrack, vocalTrack],
      "timingGuideNoteFilter",
    );

    expect(limited.map(({ id }) => id)).toEqual([
      "guitar-after",
      "vocal-before",
    ]);
  });

  it("applies stem-amplitude velocities to every separated track", () => {
    const store = createStore();
    store.createProject({
      name: "velocity scope",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    const project = store.getSnapshot().project!;
    const previous = project.tracks.map((track, index) => ({
      id: `note-${index}`,
      sourceInstrumentId: track.instrumentId,
      trackId: track.id,
      pitch: 36 + index * 12,
      rawStartSec: index,
      rawEndSec: index + 0.5,
      startSec: index,
      endSec: index + 0.5,
      velocity: 100,
    }));
    const collected = previous.map((note, index) => ({
      ...note,
      velocity: 40 + index * 20,
    }));

    const limited = limitAnalysisToPostTranscriptionOption(
      previous,
      collected,
      project.tracks,
      "velocityFromStemAmplitude",
    );

    expect(limited.map((note) => note.velocity)).toEqual([40, 60, 80]);
  });

  it("updates analysis velocities without replacing manually edited notes", () => {
    const store = createStore();
    store.createProject({
      name: "velocity postprocessing",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
      model,
      mode: "separated",
    });
    const pianoTrack = store.getSnapshot().project!.tracks[0];
    store.beginJob("initial-transcription");
    for (const [id, pitch, startSec] of [
      ["edited", 60, 1],
      ["unchanged", 62, 2],
    ] as const) {
      store.applyJobEvent({
        type: "note",
        id,
        sourceInstrumentId: "acoustic_piano",
        trackId: pianoTrack.id,
        pitch,
        rawStartSec: startSec,
        rawEndSec: startSec + 0.5,
        startSec,
        endSec: startSec + 0.5,
        velocity: 100,
      });
    }
    store.applyJobEvent({
      type: "transcription_input_result",
      inputName: "direct",
      role: "primary",
      transcriptionPass: "original_audio",
      notes: store.getSnapshot().project!.notes.map((note) => ({ ...note })),
    });
    store.applyJobEvent({ type: "state", status: "completed", backend: "CPU" });
    const completedAt = store.getSnapshot().project!.transcription!.completedAt;
    const analysis = store.getTranscriptionAnalysisNotes();
    store.setSelection(["edited"]);
    store.moveSelectedNotesInTime(0.25);

    store.applyStemAmplitudeVelocityResult(
      analysis.map((note) => ({ ...note, velocity: 48 })),
      true,
    );

    const updated = store.getSnapshot().project!;
    expect(updated.notes.find((note) => note.id === "edited")).toMatchObject({
      startSec: 1.25,
      velocity: 100,
    });
    expect(updated.notes.find((note) => note.id === "unchanged")?.velocity)
      .toBe(48);
    expect(updated.transcription?.velocityFromStemAmplitude).toBe(true);
    expect(updated.transcription?.completedAt).toBe(completedAt);
    expect(store.getTranscriptionAnalysisNotes().map((note) => note.velocity))
      .toEqual([48, 48]);
  });

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
      formatVersion: 5,
      projectId: "id-4",
      name: "song",
      sourceAudio: {
        absolutePath: audio.absolutePath,
        sha256: audio.sha256,
        timelineOffsetSec: 0,
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
      1, 33, null,
    ]);
    expect(
      state.project?.tracks.map((track) => track.playbackVolume),
    ).toEqual([100, 100, 100]);
    const pianoTrackId = state.project!.tracks[0].id;
    store.setPlaybackVolume(pianoTrackId, 42);
    expect(
      store.getSnapshot().project?.tracks[0].playbackVolume,
    ).toBe(42);
    expect(state.separatedSettings.timingGuideNoteFilter).toBe(true);
  });

  it("retains the current source selection after returning to the main menu", () => {
    const store = createStore();
    store.createProject({
      name: "selected song",
      audio,
      bpm: 128,
      beatOffsetSec: 0.35,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });

    store.closeProject();

    expect(store.getSnapshot()).toMatchObject({
      screen: "new-project",
      project: null,
      recentSourceSelection: {
        audio,
        name: "selected song",
        bpm: 128,
        beatOffsetSec: 0.35,
      },
    });
  });

  it("creates automatic tracks from job events without a preset", () => {
    const store = createStore();
    store.createProject({
      name: "automatic",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      instruments,
      instrumentSelectionMode: "automatic",
    });
    expect(store.getSnapshot().project?.tracks).toEqual([]);
    expect(store.getSnapshot().presetId).toBeNull();

    store.beginJob("job-auto");
    store.applyJobEvent({
      type: "track",
      track: {
        id: "auto-piano",
        displayName: "Piano",
        instrumentId: "acoustic_piano",
        color: "#4C9AFF",
        kind: "pitched",
        order: 1,
        midiChannel: 1,
        gmProgram: 0,
        playbackOctaveShift: 0,
        playbackVolume: 100,
        mute: false,
        solo: false,
      },
    });
    store.applyJobEvent({
      type: "note",
      id: "auto-note",
      sourceInstrumentId: "acoustic_piano",
      trackId: "auto-piano",
      pitch: 60,
      rawStartSec: 1,
      rawEndSec: 1.5,
      startSec: 1,
      endSec: 1.5,
      velocity: 100,
    });

    expect(store.getSnapshot().project?.tracks).toHaveLength(1);
    expect(store.getSnapshot().project?.notes).toHaveLength(1);
  });

  it("applies playback control changes immutably and notifies subscribers", () => {
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

    store.selectPlaybackSource("transcription");
    store.togglePlaybackTrackSolo(trackId);

    const current = store.getSnapshot().project;
    expect(store.getSnapshot().playbackSource).toBe("transcription");
    expect(current).not.toBe(previous);
    expect(current?.tracks[0]).toMatchObject({ mute: false, solo: true });
    expect(current?.tracks.slice(1).every((track) => track.mute)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["original", true, false],
    ["transcription", false, true],
    ["comparison", false, false],
  ] as const)(
    "applies %s mode to streamed tracks and separated sources",
    (source, trackMute, stemMute) => {
      const store = createStore();
      store.createProject({
        name: `stream-${source}`,
        audio,
        bpm: 120,
        numerator: 4,
        denominator: 4,
        instruments,
        instrumentSelectionMode: "automatic",
        mode: "separated",
      });
      store.beginJob(`job-${source}`);
      store.selectPlaybackSource(source);
      store.applyJobEvent({
        type: "stem",
        stem: {
          type: "piano",
          cachePath: "D:\\cache\\piano.wav",
          sha256: "e".repeat(64),
          sampleRate: 44100,
          channels: 2,
          mute: false,
          solo: false,
        },
      });
      store.applyJobEvent({
        type: "track",
        track: {
          id: "streamed-piano",
          displayName: "Piano",
          instrumentId: "acoustic_piano",
          color: "#4C9AFF",
          kind: "pitched",
          order: 1,
          midiChannel: 1,
          gmProgram: 0,
          playbackOctaveShift: 0,
          playbackVolume: 100,
          mute: false,
          solo: false,
        },
      });

      const state = store.getSnapshot();
      expect(state.playbackSource).toBe(source);
      expect(state.project?.tracks[0]).toMatchObject({
        mute: trackMute,
        solo: false,
      });
      expect(state.project?.stems[0]).toMatchObject({
        mute: stemMute,
        solo: false,
      });
    },
  );

  it("preserves a separated-source control when stem metadata is replaced", () => {
    const store = createStore();
    store.createProject({
      name: "stem-replacement",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
      mode: "separated",
    });
    store.beginJob("stem-replacement-job");
    const stemEvent = {
      type: "stem" as const,
      stem: {
        type: "piano" as const,
        cachePath: "D:\\cache\\piano.wav",
        sha256: "e".repeat(64),
        sampleRate: 44100 as const,
        channels: 2 as const,
        mute: false,
        solo: false,
      },
    };
    store.applyJobEvent(stemEvent);
    store.togglePlaybackStemMute("piano");
    store.applyJobEvent({
      ...stemEvent,
      stem: { ...stemEvent.stem, sha256: "f".repeat(64) },
    });

    expect(store.getSnapshot().project?.stems[0]).toMatchObject({
      sha256: "f".repeat(64),
      mute: true,
      solo: false,
    });
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
      transcriptionInputName: "vocals",
      transcriptionPass: "drums_added_audio",
      inputPassIndex: 1,
      inputPassCount: 1,
    });
    expect(store.getSnapshot().job?.detail).toBe(
      "ボーカル（ドラム成分追加後、1/1）を採譜中",
    );
    const listener = vi.fn();
    store.subscribe(listener);
    store.applyJobNoteEvents([
      {
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
      },
      {
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
      },
    ]);
    expect(listener).toHaveBeenCalledTimes(1);

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
    expect(reopened.getSnapshot().hasUnsavedChanges).toBe(false);
    expect(
      reopened.getSnapshot().project?.sourceAudio.timelineOffsetSec,
    ).toBe(0);
  });

  it("tracks saved edits across stale saves and undo history", () => {
    const store = createStore();
    store.createProject({
      name: "save state",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });

    const initialProject = store.getSnapshot().project!;
    expect(store.getSnapshot().hasUnsavedChanges).toBe(true);

    store.markSaved(initialProject);
    expect(store.getSnapshot().hasUnsavedChanges).toBe(false);

    store.setBpm(121);
    const editedProject = store.getSnapshot().project!;
    expect(store.getSnapshot().hasUnsavedChanges).toBe(true);

    store.markSaved(initialProject);
    expect(store.getSnapshot().hasUnsavedChanges).toBe(true);

    store.markSaved(editedProject);
    expect(store.getSnapshot().hasUnsavedChanges).toBe(false);

    store.setBpm(122);
    expect(store.getSnapshot().hasUnsavedChanges).toBe(true);
    store.undo();
    expect(store.getSnapshot().hasUnsavedChanges).toBe(false);
    store.redo();
    expect(store.getSnapshot().hasUnsavedChanges).toBe(true);
  });

  it("stores source-separated mode and ingests separated stem metadata", () => {
    const store = createStore();
    store.createProject({
      name: "song",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
      mode: "separated",
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
        mute: false,
        solo: false,
      },
    });

    expect(store.getSnapshot().transcriptionMode).toBe("separated");
    expect(store.getSnapshot().project?.stems).toEqual([
      expect.objectContaining({
        type: "drums",
        cachePath: "D:\\cache\\drums.wav",
      }),
    ]);
  });

  it("stores source-separation progress and clears it before transcription", () => {
    const store = createStore();
    store.createProject({
      name: "song",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
      mode: "separated",
    });
    store.beginJob("job-separation-progress");
    store.applyJobEvent({ type: "state", status: "separating" });
    store.applyJobEvent({
      type: "progress",
      stage: "separating",
      completed: 3,
      total: 10,
    });

    expect(store.getSnapshot().job).toMatchObject({
      status: "separating",
      completed: 3,
      total: 10,
    });

    store.applyJobEvent({ type: "state", status: "loading_model" });
    expect(store.getSnapshot().job).toMatchObject({
      status: "loading_model",
      completed: 0,
      total: 0,
    });
  });

  it("resets source controls and applies separated-source Solo", () => {
    const store = createStore();
    store.createProject({
      name: "mixed-playback",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
      mode: "separated",
    });
    store.beginJob("job-mixed-playback");
    for (const type of ["piano", "bass"] as const) {
      store.applyJobEvent({
        type: "stem",
        stem: {
          type,
          cachePath: `D:\\cache\\${type}.wav`,
          sha256: "e".repeat(64),
          sampleRate: 44100,
          channels: 2,
          mute: false,
          solo: false,
        },
      });
    }
    store.selectPlaybackSource("original");
    store.togglePlaybackStemSolo("bass");

    const mixed = store.getSnapshot().project!;
    expect(mixed.tracks.every((track) => track.mute)).toBe(true);
    expect(mixed.tracks.some((track) => track.solo)).toBe(false);
    expect(mixed.stems.find((stem) => stem.type === "bass")).toMatchObject({
      mute: false,
      solo: true,
    });
    expect(mixed.stems.find((stem) => stem.type === "piano")).toMatchObject({
      mute: true,
      solo: false,
    });
  });

  it("locks timeline edits while streaming notes and unlocks on completion", () => {
    const store = createStore();
    store.createProject({
      name: "streaming",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    const [trackId, bassTrackId] = store
      .getSnapshot()
      .project!.tracks.map((track) => track.id);
    store.beginJob("streaming-job");
    store.applyJobNoteEvents([
      {
        type: "note",
        id: "streamed-1",
        sourceInstrumentId: "acoustic_piano",
        trackId,
        pitch: 60,
        rawStartSec: 1,
        rawEndSec: 2,
        startSec: 1,
        endSec: 2,
        velocity: 100,
      },
    ]);
    store.setSelection(["streamed-1"]);
    const projectBeforeEdits = store.getSnapshot().project;

    expect(isProjectEditingLocked(store.getSnapshot().job)).toBe(true);
    for (const edit of [
      () => store.setBpm(121),
      () => store.setSelectedNoteAsMeasureStart(),
      () => store.quantizeAll("1/8"),
      () => store.shiftAllNotes(0.5),
      () => store.shiftTrackNotes(trackId, 0.5),
      () => store.moveSelectedNotesInTime(0.5),
      () => store.moveSelectedNotesOnPianoRoll(0.5, 1),
      () => store.resizeNoteEnd("streamed-1", 2.5),
      () => store.undo(),
      () => store.redo(),
    ]) {
      expect(edit).toThrow("採譜中は編集できません");
    }
    expect(store.getSnapshot().project).toBe(projectBeforeEdits);

    store.moveSelectedNotes(bassTrackId);
    expect(store.getSnapshot().project?.notes[0]).toMatchObject({
      id: "streamed-1",
      trackId: bassTrackId,
    });
    store.applyJobNoteEvents([
      {
        type: "note",
        id: "streamed-1",
        sourceInstrumentId: "acoustic_piano",
        trackId,
        pitch: 60,
        rawStartSec: 1,
        rawEndSec: 2.25,
        startSec: 1,
        endSec: 2.25,
        velocity: 100,
      },
    ]);
    expect(store.getSnapshot().project?.notes[0]).toMatchObject({
      id: "streamed-1",
      trackId: bassTrackId,
      endSec: 2.25,
    });

    store.deleteSelectedNotes();
    expect(store.getSnapshot().project?.notes).toHaveLength(0);
    store.applyJobNoteEvents([
      {
        type: "note",
        id: "streamed-1",
        sourceInstrumentId: "acoustic_piano",
        trackId,
        pitch: 60,
        rawStartSec: 1,
        rawEndSec: 2.5,
        startSec: 1,
        endSec: 2.5,
        velocity: 100,
      },
    ]);
    expect(store.getSnapshot().project?.notes).toHaveLength(0);

    store.addNote({
      trackId,
      pitch: 67,
      startSec: 5,
      endSec: 5.5,
    });
    const addedNote = store.getSnapshot().project?.notes[0];
    expect(addedNote).toMatchObject({
      trackId,
      pitch: 67,
      startSec: 5,
      endSec: 5.5,
    });
    expect(store.getSnapshot().selectedNoteIds).toEqual(
      new Set([addedNote?.id]),
    );

    store.applyJobNoteEvents([
      {
        type: "note",
        id: "streamed-2",
        sourceInstrumentId: "acoustic_piano",
        trackId,
        pitch: 64,
        rawStartSec: 3,
        rawEndSec: 4,
        startSec: 3,
        endSec: 4,
        velocity: 100,
      },
    ]);
    expect(store.getSnapshot().project?.notes).toHaveLength(2);

    completeJobWithPrimaryResult(store);
    expect(isProjectEditingLocked(store.getSnapshot().job)).toBe(false);
    expect(
      store.getSnapshot().project?.notes.find(({ id }) => id === addedNote?.id),
    ).toMatchObject({
      trackId,
      pitch: 67,
      startSec: 5,
      endSec: 5.5,
    });
    store.shiftAllNotes(0.5);
    expect(
      store.getSnapshot().project?.notes.map((note) => note.startSec),
    ).toEqual([3.5, 5.5]);
  });

  it("unlocks timeline edits when transcription is cancelled", () => {
    const store = createStore();
    store.createProject({
      name: "cancelled",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    store.beginJob("cancelled-job");

    expect(isProjectEditingLocked(store.getSnapshot().job)).toBe(true);
    store.applyJobEvent({ type: "state", status: "cancelled" });
    expect(isProjectEditingLocked(store.getSnapshot().job)).toBe(false);
    expect(() => store.setBpm(121)).not.toThrow();
  });

  it("uses the stored beat phase when adjusting every note endpoint", () => {
    const store = createStore();
    store.createProject({
      name: "song",
      audio,
      bpm: 120,
      beatOffsetSec: 0.1,
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
    completeJobWithPrimaryResult(store);

    store.quantizeAll("1/8");
    expect(store.getSnapshot().project?.notes[0].startSec).toBeCloseTo(0.35);
    expect(store.getSnapshot().project?.notes[0].endSec).toBeCloseTo(0.6);

    store.shiftAllNotes(-0.05);
    expect(store.getSnapshot().project?.notes[0].startSec).toBeCloseTo(0.3);
    expect(store.getSnapshot().project?.notes[0].endSec).toBeCloseTo(0.55);
    expect(store.getSnapshot().project?.notes[0].rawStartSec).toBe(0.34);
    expect(store.getSnapshot().project?.tempo.beatOffsetSec).toBe(0.1);
    expect(
      store.getSnapshot().project?.sourceAudio.timelineOffsetSec,
    ).toBeCloseTo(-0.05);

    store.undo();
    expect(
      store.getSnapshot().project?.sourceAudio.timelineOffsetSec,
    ).toBe(0);
    store.redo();
    expect(
      store.getSnapshot().project?.sourceAudio.timelineOffsetSec,
    ).toBeCloseTo(-0.05);
  });

  it("shifts one track without moving the source audio timeline", () => {
    const store = createStore();
    store.createProject({
      name: "track timing",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    const [firstTrack, secondTrack] = store.getSnapshot().project!.tracks;
    store.beginJob("track-timing");
    for (const [id, trackId, pitch] of [
      ["first", firstTrack.id, 60],
      ["second", secondTrack.id, 64],
    ] as const) {
      store.applyJobEvent({
        type: "note",
        id,
        sourceInstrumentId: "acoustic_piano",
        trackId,
        pitch,
        rawStartSec: 1,
        rawEndSec: 2,
        startSec: 1,
        endSec: 2,
        velocity: 100,
      });
    }
    completeJobWithPrimaryResult(store);

    store.shiftTrackNotes(firstTrack.id, 0.05);

    const project = store.getSnapshot().project!;
    expect(
      project.notes.find((note) => note.id === "first")?.startSec,
    ).toBeCloseTo(1.05);
    expect(
      project.notes.find((note) => note.id === "second")?.startSec,
    ).toBe(1);
    expect(project.sourceAudio.timelineOffsetSec).toBe(0);
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
    completeJobWithPrimaryResult(store);
    store.shiftAllNotes(0.2);
    store.setSelection(["measure-start"]);
    const before = store.getSnapshot().project!;
    const relativeStartSec =
      before.notes[0].startSec -
      before.sourceAudio.timelineOffsetSec;

    store.setSelectedNoteAsMeasureStart();

    const project = store.getSnapshot().project!;
    expect(project.tempo.bpm).toBe(120);
    expect(project.tempo.beatOffsetSec).toBeCloseTo(1.45);
    expect(
      project.notes[0].startSec -
        project.sourceAudio.timelineOffsetSec,
    ).toBeCloseTo(relativeStartSec);
    expect(store.getSnapshot().selectedNoteIds).toEqual(
      new Set(["measure-start"]),
    );
  });

  it("undoes and redoes note movement, resizing and deletion", () => {
    const store = createStore();
    store.createProject({
      name: "editable",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    const trackId = store.getSnapshot().project!.tracks[0].id;
    store.beginJob("completed-job");
    store.applyJobEvent({
      type: "note",
      id: "editable-note",
      sourceInstrumentId: "acoustic_piano",
      trackId,
      pitch: 60,
      rawStartSec: 1,
      rawEndSec: 2,
      startSec: 1,
      endSec: 2,
      velocity: 100,
    });
    completeJobWithPrimaryResult(store);
    store.setSelection(["editable-note"]);

    store.moveSelectedNotesOnPianoRoll(0.5, 2);
    store.resizeNoteEnd("editable-note", 2.75);
    store.deleteSelectedNotes();

    expect(store.getSnapshot()).toMatchObject({
      canUndo: true,
      canRedo: false,
    });
    expect(store.getSnapshot().project?.notes).toEqual([]);

    store.undo();
    expect(store.getSnapshot().project?.notes[0]).toMatchObject({
      pitch: 62,
      startSec: 1.5,
      endSec: 2.75,
    });
    store.undo();
    expect(store.getSnapshot().project?.notes[0]).toMatchObject({
      pitch: 62,
      startSec: 1.5,
      endSec: 2.5,
    });
    store.undo();
    expect(store.getSnapshot().project?.notes[0]).toMatchObject({
      pitch: 60,
      startSec: 1,
      endSec: 2,
    });
    expect(store.getSnapshot()).toMatchObject({
      canUndo: false,
      canRedo: true,
    });

    store.redo();
    store.redo();
    store.redo();
    expect(store.getSnapshot().project?.notes).toEqual([]);
    expect(store.getSnapshot()).toMatchObject({
      canUndo: true,
      canRedo: false,
    });
  });

  it("adds a user note and deletes an explicit set as single history entries", () => {
    const store = createStore();
    store.createProject({
      name: "drawn-notes",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    const trackId = store.getSnapshot().project!.tracks[0].id;

    store.addNote({
      trackId,
      pitch: 64,
      startSec: 1,
      endSec: 1.25,
    });

    const addedNote = store.getSnapshot().project!.notes[0];
    expect(addedNote).toMatchObject({
      trackId,
      pitch: 64,
      rawStartSec: 1,
      rawEndSec: 1.25,
      startSec: 1,
      endSec: 1.25,
      velocity: 100,
    });
    expect(store.getSnapshot().selectedNoteIds).toEqual(
      new Set([addedNote.id]),
    );

    store.addNote({
      trackId,
      pitch: 67,
      startSec: 2,
      endSec: 2.25,
    });
    const secondNote = store
      .getSnapshot()
      .project!.notes.find(({ pitch }) => pitch === 67)!;
    store.deleteNotesByIds(new Set([addedNote.id, secondNote.id]));
    expect(store.getSnapshot().project?.notes).toEqual([]);

    store.undo();
    expect(store.getSnapshot().project?.notes).toHaveLength(2);
  });

  it("copies, pastes, splits, joins and changes selected note duration", () => {
    const store = createStore();
    store.createProject({
      name: "advanced-editing",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    const trackId = store.getSnapshot().project!.tracks[0].id;
    store.addNote({ trackId, pitch: 60, startSec: 1, endSec: 1.5 });

    const copied = store.copySelectedNotes();
    store.pasteNotes(copied, 3);
    const pasted = store.getSnapshot().project!.notes.find(
      (item) => item.startSec === 3,
    )!;
    expect(pasted).toMatchObject({ pitch: 60, startSec: 3, endSec: 3.5 });

    store.splitSelectedNotes(3.25);
    expect(
      store.getSnapshot().project!.notes.filter((item) => item.startSec >= 3),
    ).toMatchObject([
      { startSec: 3, endSec: 3.25 },
      { startSec: 3.25, endSec: 3.5 },
    ]);

    store.joinSelectedNotes(0);
    expect(
      store.getSnapshot().project!.notes.filter((item) => item.startSec >= 3),
    ).toMatchObject([{ startSec: 3, endSec: 3.5 }]);

    store.setSelectedNoteDuration(0.25);
    expect(store.getSnapshot().project!.notes.find(({ id }) => id === pasted.id)).toMatchObject({
      startSec: 3,
      endSec: 3.25,
    });

    store.resizeNoteStart(pasted.id, 3.125);
    expect(store.getSnapshot().project!.notes.find(({ id }) => id === pasted.id)).toMatchObject({
      startSec: 3.125,
      endSec: 3.25,
    });
  });

  it("pastes copied notes while transcription is running", () => {
    const store = createStore();
    store.createProject({
      name: "paste-during-transcription",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });
    const trackId = store.getSnapshot().project!.tracks[0].id;
    store.addNote({ trackId, pitch: 60, startSec: 1, endSec: 1.5 });
    const copied = store.copySelectedNotes();

    store.beginJob("paste-job");
    store.pasteNotes(copied, 3);

    const pasted = store.getSnapshot().project!.notes.find(
      (note) => note.startSec === 3,
    );
    expect(pasted).toMatchObject({ pitch: 60, startSec: 3, endSec: 3.5 });

    completeJobWithPrimaryResult(store);
    expect(
      store.getSnapshot().project!.notes.find((note) => note.id === pasted?.id),
    ).toMatchObject({ pitch: 60, startSec: 3, endSec: 3.5 });
  });

  it("undoes and redoes score settings", () => {
    const store = createStore();
    store.createProject({
      name: "score-settings",
      audio,
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset,
      instruments,
    });

    store.updateScoreSettings({ composer: "Composer", keyFifths: 2 });
    expect(store.getSnapshot().project?.score).toMatchObject({
      composer: "Composer",
      keyFifths: 2,
    });

    store.undo();
    expect(store.getSnapshot().project?.score).toMatchObject({
      composer: "",
      keyFifths: 0,
    });

    store.redo();
    expect(store.getSnapshot().project?.score).toMatchObject({
      composer: "Composer",
      keyFifths: 2,
    });
  });
});
