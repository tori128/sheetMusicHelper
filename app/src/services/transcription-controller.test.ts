import { describe, expect, it, vi } from "vitest";
import type { LocalApiClient } from "../api";
import { ProjectStore } from "../store/project-store";
import type {
  AudioInfo,
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

function createStore(): ProjectStore {
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
    preset,
    instruments,
    model,
  });
  return store;
}

describe("transcription controller", () => {
  it("starts a local job and streams notes into the project", async () => {
    const store = createStore();
    const initialProject = store.getSnapshot().project!;
    const trackId = initialProject.tracks[0].id;
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
    );
    expect(store.getSnapshot().job).toMatchObject({
      id: "job-1",
      status: "completed",
      completed: 1,
      total: 1,
    });
    expect(store.getSnapshot().project?.notes).toHaveLength(1);
    expect(store.getSnapshot().project?.transcription).toMatchObject({
      mode: "direct",
      presetId: preset.id,
      modelProfileId: model.id,
      modelSha256: model.sha256,
      backend: "CPU",
    });
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
});
