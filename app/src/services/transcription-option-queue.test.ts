import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalApiClient } from "../api";
import {
  ProjectStore,
  type ProjectStoreState,
} from "../store/project-store";
import type {
  ModelProfile,
  ProjectDocument,
  ProjectNote,
  SeparatedTranscriptionSettings,
} from "../types";
import { TranscriptionOptionQueue } from "./transcription-option-queue";

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

const initialSettings: SeparatedTranscriptionSettings = {
  drumOnsetGuide: true,
  timingGuideNoteFilter: true,
  velocityFromStemAmplitude: true,
};

const note: ProjectNote = {
  id: "note",
  sourceInstrumentId: "acoustic_piano",
  trackId: "track",
  pitch: 60,
  rawStartSec: 0,
  rawEndSec: 1,
  startSec: 0,
  endSec: 1,
  velocity: 100,
};

const track = {
  id: "track",
  displayName: "Piano",
  instrumentId: "acoustic_piano",
  color: "#112233",
  kind: "pitched" as const,
  order: 1,
  midiChannel: 1,
  gmProgram: 0,
  playbackOctaveShift: 0 as const,
  playbackVolume: 100,
  mute: false,
  solo: false,
};

const project: ProjectDocument = {
  formatVersion: 5,
  appVersion: "0.1.0",
  projectId: "project",
  name: "song",
  sourceAudio: {
    absolutePath: "D:\\music\\song.wav",
    relativePath: "song.wav",
    sha256: "a".repeat(64),
    durationSec: 10,
    sampleRate: 44100,
    channels: 2,
    timelineOffsetSec: 0,
  },
  tempo: {
    bpm: 120,
    beatOffsetSec: 0,
    timeSignature: { numerator: 4, denominator: 4 },
    ppq: 480,
    quantizeGrid: "1/16",
  },
  transcription: {
    mode: "separated",
    transcriptionProfile: "high_accuracy",
    instrumentSelectionMode: "fixed",
    presetId: null,
    ...initialSettings,
    modelProfileId: model.id,
    modelSha256: model.sha256,
    backend: "CPU",
    completedAt: "2026-08-12T00:00:00.000Z",
    inputResults: [
      {
        inputName: "piano",
        role: "primary",
        transcriptionPass: "drums_added_audio",
        notes: [note],
      },
    ],
  },
  tracks: [track],
  notes: [note],
  stems: [],
  score: {
    composer: "",
    arranger: "",
    copyright: "",
    keyFifths: 0,
    keyMode: "major",
    pickupTicks: 0,
    includeChordSymbols: true,
    chords: [],
    trackSettings: {},
  },
  viewState: {
    activeRoll: "pitched",
    horizontalZoom: 1,
    verticalZoom: 1,
    scrollTimeSec: 0,
  },
};

function storeFor(
  settings: SeparatedTranscriptionSettings,
  overrides: Partial<ProjectStore>,
): ProjectStore {
  return {
    getSnapshot: () =>
      ({
        project,
        model: null,
        transcriptionMode: "separated",
        inferenceBackend: "CPU",
        separatedSettings: settings,
        instrumentSelectionMode: "fixed",
        transcriptionProfile: "high_accuracy",
      }) as ProjectStoreState,
    ...overrides,
  } as ProjectStore;
}

describe("TranscriptionOptionQueue", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("updates velocities without applying structural transcription options", async () => {
    const settings = {
      ...initialSettings,
      velocityFromStemAmplitude: false,
    };
    const applyVelocityResult = vi.fn();
    const applyStructuralResult = vi.fn();
    const store = storeFor(settings, {
      getTranscriptionAnalysisNotes: vi.fn(() => [note]),
      applyStemAmplitudeVelocityResult: applyVelocityResult,
      applySavedTranscriptionOptionResult: applyStructuralResult,
    });
    const client = {
      applyStemAmplitudeVelocitySetting: vi
        .fn()
        .mockResolvedValue([{ ...note, velocity: 100 }]),
      applySavedTranscriptionOptions: vi.fn(),
      startTranscription: vi.fn(),
    } as unknown as LocalApiClient;
    const queue = new TranscriptionOptionQueue(client, store);

    queue.enqueue("velocityFromStemAmplitude", settings);
    await vi.waitFor(() => expect(applyVelocityResult).toHaveBeenCalledOnce());

    expect(client.startTranscription).not.toHaveBeenCalled();
    expect(client.applySavedTranscriptionOptions).not.toHaveBeenCalled();
    expect(applyStructuralResult).not.toHaveBeenCalled();
    queue.dispose();
  });

  it("applies saved input results without starting transcription", async () => {
    const settings = {
      ...initialSettings,
      timingGuideNoteFilter: false,
      velocityFromStemAmplitude: false,
    };
    const store = new ProjectStore();
    store.openProject(project, model);
    const applyResult = vi.spyOn(
      store,
      "applySavedTranscriptionOptionResult",
    );
    const applySaved = vi.fn().mockResolvedValue([note]);
    const client = {
      applySavedTranscriptionOptions: applySaved,
      applyStemAmplitudeVelocitySetting: vi.fn(),
      startTranscription: vi.fn(),
    } as unknown as LocalApiClient;
    const queue = new TranscriptionOptionQueue(client, store);

    queue.enqueue("timingGuideNoteFilter", settings);
    await vi.waitFor(() => expect(applyResult).toHaveBeenCalledOnce());

    expect(applySaved).toHaveBeenCalledWith(
      project.transcription?.inputResults,
      store.getSnapshot().project?.tracks,
      "fixed",
      settings,
      expect.any(AbortSignal),
    );
    expect(client.startTranscription).not.toHaveBeenCalled();
    expect(applyResult).toHaveBeenCalledWith(
      [note],
      settings,
      "timingGuideNoteFilter",
      project.transcription?.inputResults,
    );
    expect(
      store.getSnapshot().project?.transcription?.timingGuideNoteFilter,
    ).toBe(false);
    queue.dispose();
  });

  it("applies stem-amplitude velocity after saved structural processing", async () => {
    const settings = {
      ...initialSettings,
      timingGuideNoteFilter: false,
    };
    const applyResult = vi.fn();
    const store = storeFor(settings, {
      applySavedTranscriptionOptionResult: applyResult,
    });
    const client = {
      applySavedTranscriptionOptions: vi.fn().mockResolvedValue([note]),
      applyStemAmplitudeVelocitySetting: vi
        .fn()
        .mockResolvedValue([{ ...note, velocity: 72 }]),
      startTranscription: vi.fn(),
    } as unknown as LocalApiClient;
    const queue = new TranscriptionOptionQueue(client, store);

    queue.enqueue("timingGuideNoteFilter", settings);
    await vi.waitFor(() => expect(applyResult).toHaveBeenCalledOnce());

    expect(client.applyStemAmplitudeVelocitySetting).toHaveBeenCalledWith(
      [note],
      project.stems,
      true,
      expect.any(AbortSignal),
    );
    expect(applyResult).toHaveBeenCalledWith(
      [{ ...note, velocity: 72 }],
      settings,
      "timingGuideNoteFilter",
      project.transcription?.inputResults,
    );
    expect(client.startTranscription).not.toHaveBeenCalled();
    queue.dispose();
  });

  it("collects and saves only missing drumless timing references when enabling the option", async () => {
    const settings = {
      ...initialSettings,
      timingGuideNoteFilter: true,
    };
    const storedProject: ProjectDocument = {
      ...project,
      transcription: {
        ...project.transcription!,
        timingGuideNoteFilter: false,
      },
    };
    const store = new ProjectStore();
    store.openProject(storedProject, model);
    const referenceNote = { ...note, id: "reference-note" };
    const startTranscription = vi.fn().mockResolvedValue("reference-job");
    const streamJobEvents = vi.fn().mockImplementation(
      async (
        _jobId: string,
        onEvent: (event: unknown) => void,
      ) => {
        onEvent({
          type: "progress",
          stage: "transcribing",
          completed: 0,
          total: 1,
          transcriptionInputName: "piano",
          transcriptionPass: "separated_audio",
          inputPassIndex: 1,
          inputPassCount: 1,
        });
        onEvent({
          type: "transcription_input_result",
          inputName: "piano",
          role: "timing_reference",
          transcriptionPass: "separated_audio",
          notes: [referenceNote],
        });
        onEvent({ type: "state", status: "completed" });
      },
    );
    const applySaved = vi.fn().mockResolvedValue([note]);
    const client = {
      startTranscription,
      streamJobEvents,
      cancelTranscription: vi.fn(),
      applySavedTranscriptionOptions: applySaved,
      applyStemAmplitudeVelocitySetting: vi
        .fn()
        .mockResolvedValue([{ ...note, velocity: 100 }]),
    } as unknown as LocalApiClient;
    const queue = new TranscriptionOptionQueue(client, store);

    queue.enqueue("timingGuideNoteFilter", settings);
    await vi.waitFor(() => expect(applySaved).toHaveBeenCalledOnce());

    expect(startTranscription).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project" }),
      model,
      "separated",
      "CPU",
      settings,
      "fixed",
      "high_accuracy",
      ["piano"],
      "timing_reference_only",
    );
    expect(streamJobEvents).toHaveBeenCalledWith(
      "reference-job",
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(applySaved.mock.calls[0][0]).toEqual([
      storedProject.transcription!.inputResults[0],
      {
        inputName: "piano",
        role: "timing_reference",
        transcriptionPass: "separated_audio",
        notes: [referenceNote],
      },
    ]);
    expect(
      store.getSnapshot().project?.transcription?.inputResults,
    ).toContainEqual(
      expect.objectContaining({
        inputName: "piano",
        role: "timing_reference",
      }),
    );
    queue.dispose();
  });
});
