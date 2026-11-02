import { describe, expect, it, vi } from "vitest";
import type { LocalApiClient } from "../api";
import { ProjectStore } from "../store/project-store";
import type {
  AudioInfo,
  SeparatedTranscriptionSettings,
  InstrumentDefinition,
  ModelProfile,
  PresetDefinition,
} from "../types";
import {
  cancelProjectTranscription,
  startProjectTranscription,
} from "./transcription-controller";

const audio: AudioInfo = {
  absolutePath: "D:\\music\\song.wav",
  sha256: "a".repeat(64),
  durationSec: 12,
  sampleRate: 44100,
  channels: 2,
  codecName: "pcm_s16le",
};

const instruments: InstrumentDefinition[] = [
  {
    id: "acoustic_piano",
    displayNameJa: "ピアノ",
    kind: "pitched",
    gmProgram: 0,
    gmPrograms: [{ program: 0, displayNameJa: "ピアノ" }],
  },
];

const preset: PresetDefinition = {
  id: "00000000-0000-0000-0000-000000000001",
  key: "piano",
  name: "ピアノ",
  trackCount: 1,
  tracks: [
    {
      displayName: "Piano",
      instrumentId: "acoustic_piano",
      color: "#4C9AFF",
      kind: "pitched",
      order: 1,
    },
  ],
};

const model: ModelProfile = {
  id: "00000000-0000-0000-0000-000000000002",
  profileName: "MuScriptor Small",
  modelPath: "D:\\models\\small\\model.safetensors",
  fileName: "model.safetensors",
  sha256: "b".repeat(64),
  variant: "small",
  dtype: "float32",
  defaultBackend: "CPU",
};

function createStore(
  mode: "direct" | "separated" = "direct",
  separatedSettings?: Partial<SeparatedTranscriptionSettings>,
  instrumentSelectionMode: "fixed" | "automatic" = "fixed",
): ProjectStore {
  let sequence = 0;
  const store = new ProjectStore(() => `00000000-0000-0000-0000-${String(
    ++sequence,
  ).padStart(12, "0")}`);
  store.createProject({
    name: "song",
    audio,
    bpm: 120,
    numerator: 4,
    denominator: 4,
    preset: instrumentSelectionMode === "fixed" ? preset : undefined,
    instruments,
    instrumentSelectionMode,
    model,
    mode,
    separatedSettings: {
      drumOnsetGuide: true,
      timingGuideNoteFilter: false,
      velocityFromStemAmplitude: true,
      ...separatedSettings,
    },
  });
  return store;
}

function emitPrimaryInputResult(
  onEvent: (event: Record<string, unknown>) => void,
  inputName = "direct",
  transcriptionPass = "original_audio",
): void {
  onEvent({
    type: "transcription_input_result",
    inputName,
    role: "primary",
    transcriptionPass,
    notes: [],
  });
}

describe("transcription controller", () => {
  it("starts a local job and streams notes into the project", async () => {
    const store = createStore("direct");
    const initialProject = store.getSnapshot().project!;
    const trackId = initialProject.tracks[0].id;
    const applyJobNoteEvents = vi.spyOn(store, "applyJobNoteEvents");
    const client = {
      startTranscription: vi.fn().mockResolvedValue("job-1"),
      streamJobEvents: vi.fn(
        async (
          _jobId: string,
          onEvent: (event: Record<string, unknown>) => void,
        ) => {
          onEvent({
            type: "progress",
            stage: "transcribing",
            completed: 1,
            total: 1,
          });
          onEvent({
            type: "note",
            id: "00000000-0000-0000-0000-000000000010",
            sourceInstrumentId: "acoustic_piano",
            trackId,
            pitch: 60,
            rawStartSec: 1,
            rawEndSec: 1.5,
            startSec: 1,
            endSec: 1.5,
            velocity: 100,
          });
          onEvent({
            type: "note",
            id: "00000000-0000-0000-0000-000000000011",
            sourceInstrumentId: "acoustic_piano",
            trackId,
            pitch: 64,
            rawStartSec: 2,
            rawEndSec: 2.5,
            startSec: 2,
            endSec: 2.5,
            velocity: 100,
          });
          emitPrimaryInputResult(onEvent);
          onEvent({ type: "state", status: "completed" });
        },
      ),
      cancelTranscription: vi.fn(),
    } as unknown as LocalApiClient;

    await startProjectTranscription(client, store);

    expect(client.startTranscription).toHaveBeenCalledWith(
      initialProject,
      model,
      "direct",
      "CPU",
      {
        drumOnsetGuide: true,
        timingGuideNoteFilter: false,
        velocityFromStemAmplitude: true,
      },
      "fixed",
      "high_accuracy",
    );
    expect(store.getSnapshot().job).toMatchObject({
      id: "job-1",
      status: "completed",
      completed: 1,
      total: 1,
    });
    expect(applyJobNoteEvents).toHaveBeenCalledTimes(1);
    expect(applyJobNoteEvents.mock.calls[0][0]).toHaveLength(2);
    expect(store.getSnapshot().project?.notes).toHaveLength(2);
    expect(store.getSnapshot().project?.transcription).toMatchObject({
      mode: "direct",
      drumOnsetGuide: true,
      timingGuideNoteFilter: false,
      velocityFromStemAmplitude: true,
      presetId: preset.id,
      modelProfileId: model.id,
      modelSha256: model.sha256,
      backend: "CPU",
      inputResults: [
        expect.objectContaining({ inputName: "direct", role: "primary" }),
      ],
    });
    expect(store.getSnapshot().project?.transcription).not.toHaveProperty(
      "beamSize",
    );
  });

  it("shows direct notes at chunk progress and removes rejected previews", async () => {
    const store = createStore("direct");
    const trackId = store.getSnapshot().project!.tracks[0].id;
    const previewId = "00000000-0000-0000-0000-000000000012";
    const client = {
      startTranscription: vi.fn().mockResolvedValue("job-preview"),
      streamJobEvents: vi.fn(
        async (
          _jobId: string,
          onEvent: (event: Record<string, unknown>) => void,
        ) => {
          onEvent({
            type: "note",
            id: previewId,
            sourceInstrumentId: "acoustic_piano",
            trackId,
            pitch: 60,
            rawStartSec: 1,
            rawEndSec: 1.5,
            startSec: 1,
            endSec: 1.5,
            velocity: 100,
          });
          expect(store.getSnapshot().project?.notes).toEqual([]);
          onEvent({
            type: "progress",
            stage: "transcribing",
            completed: 1,
            total: 2,
          });
          expect(store.getSnapshot().project?.notes.map(({ id }) => id)).toEqual([
            previewId,
          ]);
          onEvent({
            type: "note_cleanup",
            removedNoteIds: [previewId],
          });
          expect(store.getSnapshot().project?.notes).toEqual([]);
          emitPrimaryInputResult(onEvent);
          onEvent({ type: "state", status: "completed" });
        },
      ),
      cancelTranscription: vi.fn(),
    } as unknown as LocalApiClient;

    await startProjectTranscription(client, store);

    expect(store.getSnapshot().project?.notes).toEqual([]);
    expect(store.getSnapshot().job?.status).toBe("completed");
  });

  it("cancels an active local job and updates its state", async () => {
    const store = createStore();
    store.beginJob("job-2");
    const cancelTranscription = vi.fn().mockResolvedValue({
      jobId: "job-2",
      status: "transcribing",
    });
    const client = { cancelTranscription } as unknown as LocalApiClient;

    await cancelProjectTranscription(client, store);

    expect(cancelTranscription).toHaveBeenCalledWith("job-2");
    expect(store.getSnapshot().job?.status).toBe("cancelled");
  });

  it("applies automatic tracks before their deferred source-separated notes", async () => {
    const store = createStore("separated", undefined, "automatic");
    const initialProject = store.getSnapshot().project!;
    const client = {
      startTranscription: vi.fn().mockResolvedValue("job-auto"),
      streamJobEvents: vi.fn(
        async (
          _jobId: string,
          onEvent: (event: Record<string, unknown>) => void,
        ) => {
          onEvent({
            type: "track",
            track: {
              id: "auto-track",
              displayName: "Piano",
              instrumentId: "acoustic_piano",
              color: "#4C9AFF",
              kind: "pitched",
              order: 1,
              midiChannel: 1,
              gmProgram: 0,
              playbackOctaveShift: 0,
              mute: false,
              solo: false,
            },
          });
          onEvent({
            type: "note",
            id: "auto-note",
            sourceInstrumentId: "acoustic_piano",
            trackId: "auto-track",
            pitch: 60,
            rawStartSec: 1,
            rawEndSec: 1.5,
            startSec: 1,
            endSec: 1.5,
            velocity: 100,
          });
          expect(store.getSnapshot().project?.tracks).toEqual([]);
          emitPrimaryInputResult(
            onEvent,
            "piano",
            "separated_audio",
          );
          onEvent({ type: "state", status: "completed" });
        },
      ),
      cancelTranscription: vi.fn(),
    } as unknown as LocalApiClient;

    await startProjectTranscription(client, store);

    expect(client.startTranscription).toHaveBeenCalledWith(
      initialProject,
      model,
      "separated",
      "CPU",
      expect.any(Object),
      "automatic",
      "high_accuracy",
    );
    expect(store.getSnapshot().project?.tracks).toHaveLength(1);
    expect(store.getSnapshot().project?.notes).toHaveLength(1);
    expect(store.getSnapshot().project?.transcription).toMatchObject({
      instrumentSelectionMode: "automatic",
      presetId: null,
    });
  });

  it("drops deferred automatic tracks when source-separated transcription is cancelled", async () => {
    const store = createStore("separated", undefined, "automatic");
    const client = {
      startTranscription: vi.fn().mockResolvedValue("job-cancelled"),
      streamJobEvents: vi.fn(
        async (
          _jobId: string,
          onEvent: (event: Record<string, unknown>) => void,
        ) => {
          onEvent({
            type: "track",
            track: {
              id: "cancelled-track",
              displayName: "Piano",
              instrumentId: "acoustic_piano",
              color: "#4C9AFF",
              kind: "pitched",
              order: 1,
              midiChannel: 1,
              gmProgram: 0,
              playbackOctaveShift: 0,
              mute: false,
              solo: false,
            },
          });
          onEvent({ type: "state", status: "cancelled" });
        },
      ),
      cancelTranscription: vi.fn(),
    } as unknown as LocalApiClient;

    await startProjectTranscription(client, store);

    expect(store.getSnapshot().project?.tracks).toEqual([]);
    expect(store.getSnapshot().project?.notes).toEqual([]);
    expect(store.getSnapshot().job?.status).toBe("cancelled");
  });

  it("shows each completed separated-audio input", async () => {
    const store = createStore("separated");
    const initialProject = store.getSnapshot().project!;
    const trackId = initialProject.tracks[0].id;
    const applyJobNoteEvents = vi.spyOn(store, "applyJobNoteEvents");
    const note = (id: string, pitch: number) => ({
      type: "note",
      id,
      sourceInstrumentId: "acoustic_piano",
      trackId,
      pitch,
      rawStartSec: pitch,
      rawEndSec: pitch + 0.5,
      startSec: pitch,
      endSec: pitch + 0.5,
      velocity: 100,
    });
    const client = {
      startTranscription: vi.fn().mockResolvedValue("job-stems"),
      streamJobEvents: vi.fn(
        async (
          _jobId: string,
          onEvent: (event: Record<string, unknown>) => void,
        ) => {
          onEvent(note("stem-note-1", 60));
          emitPrimaryInputResult(
            onEvent,
            "drums+bass+vocals",
            "drums_added_audio",
          );
          onEvent({
            type: "partial_result",
            inputName: "drums+bass+vocals",
            completedInputs: 1,
            totalInputs: 2,
            completedPasses: 1,
            totalPasses: 2,
            noteCount: 1,
          });
          expect(applyJobNoteEvents).toHaveBeenCalledTimes(1);
          onEvent(note("stem-note-2", 64));
          emitPrimaryInputResult(
            onEvent,
            "piano",
            "drums_added_audio",
          );
          onEvent({
            type: "partial_result",
            inputName: "piano",
            completedInputs: 2,
            totalInputs: 2,
            completedPasses: 2,
            totalPasses: 2,
            noteCount: 1,
          });
          expect(applyJobNoteEvents).toHaveBeenCalledTimes(2);
          onEvent({ type: "state", status: "completed" });
        },
      ),
      cancelTranscription: vi.fn(),
    } as unknown as LocalApiClient;

    await startProjectTranscription(client, store);

    expect(applyJobNoteEvents).toHaveBeenCalledTimes(2);
    expect(applyJobNoteEvents.mock.calls[0][0]).toHaveLength(1);
    expect(applyJobNoteEvents.mock.calls[1][0]).toHaveLength(1);
    expect(store.getSnapshot().project?.notes).toHaveLength(2);
    expect(store.getSnapshot().job?.status).toBe("completed");
  });

  it("keeps completed inputs but drops an unfinished input when a job fails", async () => {
    const store = createStore("separated");
    const trackId = store.getSnapshot().project!.tracks[0].id;
    const client = {
      startTranscription: vi.fn().mockResolvedValue("job-failed"),
      streamJobEvents: vi.fn(
        async (
          _jobId: string,
          onEvent: (event: Record<string, unknown>) => void,
        ) => {
          onEvent({
            type: "note",
            id: "preview-note",
            sourceInstrumentId: "acoustic_piano",
            trackId,
            pitch: 60,
            rawStartSec: 1,
            rawEndSec: 1.5,
            startSec: 1,
            endSec: 1.5,
            velocity: 100,
          });
          onEvent({
            type: "partial_result",
            inputName: "piano",
            completedInputs: 1,
            totalInputs: 2,
            completedPasses: 1,
            totalPasses: 2,
            noteCount: 1,
          });
          expect(store.getSnapshot().project?.notes).toHaveLength(1);
          onEvent({
            type: "note",
            id: "unfinished-note",
            sourceInstrumentId: "acoustic_piano",
            trackId,
            pitch: 64,
            rawStartSec: 2,
            rawEndSec: 2.5,
            startSec: 2,
            endSec: 2.5,
            velocity: 100,
          });
          onEvent({ type: "state", status: "failed" });
        },
      ),
      cancelTranscription: vi.fn(),
    } as unknown as LocalApiClient;

    await startProjectTranscription(client, store);

    expect(store.getSnapshot().project?.notes.map((note) => note.id)).toEqual([
      "preview-note",
    ]);
    expect(store.getSnapshot().job?.status).toBe("failed");
  });

});


it("cancels the backend when cancelled before the start response", async () => {
  const store = createStore();
  let resolveStart!: (id: string) => void;
  const cancelTranscription = vi.fn().mockResolvedValue({ status: "cancelled" });
  const streamJobEvents = vi.fn().mockResolvedValue(undefined);
  const client = {
    startTranscription: () => new Promise<string>(resolve => { resolveStart = resolve; }),
    streamJobEvents,
    cancelTranscription,
  } as unknown as LocalApiClient;
  const run = startProjectTranscription(client, store);
  await cancelProjectTranscription(client, store);
  resolveStart("delayed-job");
  await run;
  expect(cancelTranscription).toHaveBeenCalledExactlyOnceWith("delayed-job");
  expect(streamJobEvents).not.toHaveBeenCalled();
  expect(store.getSnapshot().job?.status).toBe("cancelled");
});
