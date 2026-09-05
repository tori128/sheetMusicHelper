import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalApiClient } from "../api";
import { PcmSourcePlayback } from "../pcm-source-playback";
import { PlaybackAudioOutput } from "../playback-audio-output";
import { SoundFontPlaybackEngine } from "../soundfont-playback";
import { projectStore } from "../store/project-store";
import type { DesktopApi, ModelProfile } from "../types";
import { EditorScreen } from "./EditorScreen";

const renderSpectralComparisonWav = vi.hoisted(() => vi.fn());

function createPlaybackClient(
  overrides: Record<string, unknown> = {},
): LocalApiClient {
  return {
    preparePlaybackAudio: vi.fn().mockResolvedValue({
      path: "D:\\cache\\analysis.wav",
      sampleRate: 44_100,
      channels: 2,
      frameCount: 44_100 * 30,
    }),
    ...overrides,
  } as unknown as LocalApiClient;
}

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: class {
    load() {
      return Promise.resolve();
    }
    render() {}
  },
}));

vi.mock("../spectral-difference", async () => {
  const actual = await vi.importActual<typeof import("../spectral-difference")>(
    "../spectral-difference",
  );
  return {
    ...actual,
    renderSpectralComparisonWav,
  };
});

vi.mock("../services/transcription-controller", () => ({
  startProjectTranscription: vi.fn().mockResolvedValue(undefined),
  cancelProjectTranscription: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./PianoRollCanvas", () => ({
  PianoRollCanvas: ({
    followPlayhead,
    chordSpans,
    durationSec,
    playheadSec,
    editingLocked,
    spectralDifferences,
    onSeek,
  }: {
    followPlayhead: boolean;
    chordSpans: readonly { measureNumber: number; label: string }[];
    durationSec: number;
    playheadSec: number;
    editingLocked: boolean;
    spectralDifferences: readonly { value: number }[];
    onSeek(timeSec: number): void;
  }) => (
    <div
      data-testid="piano-roll"
      data-follow={String(followPlayhead)}
      data-duration={String(durationSec)}
      data-playhead={String(playheadSec)}
      data-editing-locked={String(editingLocked)}
      data-spectral-differences={String(spectralDifferences.length)}
      data-chords={chordSpans
        .map((chord) => `${chord.measureNumber}:${chord.label}`)
        .join(",")}
    >
      <button type="button" onClick={() => onSeek(5)}>
        ピアノロールで5秒へシーク
      </button>
    </div>
  ),
}));

function createChordProject(status: "completed" | "cancelled" | null) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getLocalAudioUrl: vi.fn().mockResolvedValue("file:///audio.wav"),
      loadSoundFont: vi.fn().mockResolvedValue(new Uint8Array([1])),
      writeSpectralAnalysisAudio: vi
        .fn()
        .mockResolvedValue("D:\\cache\\spectral.wav"),
      deleteSpectralAnalysisAudio: vi.fn().mockResolvedValue(undefined),
    } as unknown as DesktopApi,
  });
  projectStore.createProject({
    name: "chords",
    audio: {
      absolutePath: "D:\\audio.wav",
      sha256: "a".repeat(64),
      durationSec: 30,
      sampleRate: 44100,
      channels: 2,
      codecName: "pcm",
    },
    bpm: 120,
    numerator: 4,
    denominator: 4,
    preset: {
      id: "preset",
      key: "preset",
      name: "Piano",
      trackCount: 1,
      tracks: [
        {
          displayName: "Piano",
          instrumentId: "acoustic_piano",
          color: "#112233",
          kind: "pitched",
          order: 1,
        },
      ],
    },
    instruments: [
      {
        id: "acoustic_piano",
        displayNameJa: "ピアノ",
        kind: "pitched",
        gmProgram: 0,
        gmPrograms: [{ program: 0, displayNameJa: "ピアノ" }],
      },
    ],
  });
  projectStore.beginJob("chord-job");
  const trackId = projectStore.getSnapshot().project!.tracks[0].id;
  for (const pitch of [60, 64, 67]) {
    projectStore.applyJobEvent({
      type: "note",
      id: `note-${pitch}`,
      sourceInstrumentId: "acoustic_piano",
      trackId,
      pitch,
      rawStartSec: 0,
      rawEndSec: 1,
      startSec: 0,
      endSec: 1,
      velocity: 100,
    });
  }
  if (status !== null) {
    projectStore.applyJobEvent({ type: "state", status });
  }
  return projectStore.getSnapshot();
}

const separatedModel: ModelProfile = {
  id: "model",
  profileName: "Medium",
  modelPath: "D:\\models\\medium.safetensors",
  fileName: "medium.safetensors",
  sha256: "b".repeat(64),
  variant: "medium",
  dtype: "float16",
  defaultBackend: "CPU",
};

function createCompletedSeparatedProject() {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getLocalAudioUrl: vi.fn().mockResolvedValue("file:///audio.wav"),
      loadSoundFont: vi.fn().mockResolvedValue(new Uint8Array([1])),
    } as unknown as DesktopApi,
  });
  projectStore.createProject({
    name: "stems",
    audio: {
      absolutePath: "D:\\audio.wav",
      sha256: "a".repeat(64),
      durationSec: 30,
      sampleRate: 44100,
      channels: 2,
      codecName: "pcm",
    },
    bpm: 120,
    numerator: 4,
    denominator: 4,
    mode: "separated",
    model: separatedModel,
    preset: {
      id: "preset",
      key: "preset",
      name: "Piano",
      trackCount: 1,
      tracks: [
        {
          displayName: "Piano",
          instrumentId: "acoustic_piano",
          color: "#112233",
          kind: "pitched",
          order: 1,
        },
      ],
    },
    instruments: [
      {
        id: "acoustic_piano",
        displayNameJa: "ピアノ",
        kind: "pitched",
        gmProgram: 0,
        gmPrograms: [{ program: 0, displayNameJa: "ピアノ" }],
      },
    ],
  });
  projectStore.beginJob("stem-job");
  for (const [index, type] of [
    "drums",
    "bass",
    "vocals",
    "other",
    "piano",
    "guitar",
  ].entries()) {
    projectStore.applyJobEvent({
      type: "stem",
      stem: {
        type: type as
          | "drums"
          | "bass"
          | "vocals"
          | "other"
          | "piano"
          | "guitar",
        cachePath: `D:\\cache\\${type}.wav`,
        sha256: `${index + 1}`.repeat(64),
        sampleRate: 44100,
        channels: 2,
        mute: false,
        solo: false,
      },
    });
  }
  projectStore.applyJobEvent({
    type: "transcription_input_result",
    inputName: "piano",
    role: "primary",
    transcriptionPass: "drums_added_audio",
    notes: [],
  });
  projectStore.applyJobEvent({
    type: "state",
    status: "completed",
    backend: "CPU",
  });
  return projectStore.getSnapshot();
}

describe("EditorScreen timing controls", () => {
  afterEach(() => {
    cleanup();
    renderSpectralComparisonWav.mockReset();
    window.localStorage.removeItem("earcopy-original-volume");
    if (projectStore.getSnapshot().project !== null) {
      projectStore.closeProject();
    }
    vi.restoreAllMocks();
    if (vi.isMockFunction(URL.createObjectURL)) {
      Reflect.deleteProperty(URL, "createObjectURL");
    }
    if (vi.isMockFunction(URL.revokeObjectURL)) {
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("restarts playback at the A point and at the beginning of the timeline", async () => {
    const state = createChordProject(null);
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    const { container } = render(
      <EditorScreen
        client={createPlaybackClient()}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={state.model}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    const audio = container.querySelector("audio")!;
    const seekSlider = screen.getByRole("slider", { name: "再生位置" });
    fireEvent.change(seekSlider, { target: { value: "5" } });
    fireEvent.click(
      screen.getByRole("button", { name: "A点を現在位置に設定" }),
    );
    fireEvent.change(seekSlider, { target: { value: "8" } });
    const bButton = screen.getByRole("button", {
      name: "B点を現在位置に設定",
    });
    expect(bButton).toBeEnabled();
    fireEvent.click(bButton);

    expect(screen.getByLabelText("A-Bリピート範囲")).toHaveTextContent(
      "A 00:05.000 / B 00:08.000",
    );
    const abRepeatButton = screen.getByRole("button", { name: "A-B" });
    expect(abRepeatButton).toBeEnabled();
    fireEvent.click(abRepeatButton);
    expect(abRepeatButton).toHaveAttribute("aria-pressed", "true");
    expect(audio.currentTime).toBe(5);

    const playButton = await screen.findByRole("button", { name: "再生" });
    await waitFor(() => expect(playButton).toBeEnabled());
    fireEvent.click(playButton);
    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    fireEvent.play(audio);
    audio.currentTime = 8;
    fireEvent.timeUpdate(audio);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(audio.currentTime).toBe(5);
    expect(screen.getByRole("button", { name: "一時停止" })).toBeVisible();

    const fullRepeatButton = screen.getByRole("button", { name: "全体" });
    fireEvent.click(fullRepeatButton);
    expect(fullRepeatButton).toHaveAttribute("aria-pressed", "true");
    expect(abRepeatButton).toHaveAttribute("aria-pressed", "false");
    audio.currentTime = 30;
    fireEvent.ended(audio);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(3));
    expect(audio.currentTime).toBe(0);
    expect(screen.getByRole("button", { name: "一時停止" })).toBeVisible();
  });

  it("plays saved transcription when source and stem files are unavailable", async () => {
    const state = createCompletedSeparatedProject();
    const trackId = state.project!.tracks[0].id;
    projectStore.addNote({
      trackId,
      pitch: 60,
      startSec: 0.5,
      endSec: 1.5,
    });
    const updated = projectStore.getSnapshot();
    const createObjectUrl = vi.fn(() => "blob:transcription-clock");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getLocalAudioUrl: vi
          .fn()
          .mockRejectedValue(new Error("音源ファイルが見つかりません")),
        loadSoundFont: vi.fn().mockResolvedValue(new Uint8Array([1])),
      } as unknown as DesktopApi,
    });
    const audioOutput = {
      context: {},
      destination: {},
      start: vi.fn().mockResolvedValue(undefined),
      setOutputDevice: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(PlaybackAudioOutput, "create").mockResolvedValue(
      audioOutput as unknown as PlaybackAudioOutput,
    );
    const engine = {
      setTimelineOffset: vi.fn(),
      setProject: vi.fn(),
      setSource: vi.fn(),
      setMetronome: vi.fn(),
      setTranscriptionDelayMs: vi.fn(),
      prepare: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      startAt: vi.fn(),
      currentTimelineTime: vi.fn(() => 0),
      pause: vi.fn(),
      seek: vi.fn(),
      stopNotePreview: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(SoundFontPlaybackEngine, "create").mockResolvedValue(
      engine as unknown as SoundFontPlaybackEngine,
    );
    const sourceMixerCreate = vi.spyOn(PcmSourcePlayback, "create");
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    const { container, unmount } = render(
      <EditorScreen
        client={createPlaybackClient()}
        project={updated.project!}
        hasUnsavedChanges={updated.hasUnsavedChanges}
        model={updated.model}
        job={updated.job}
        transcriptionMode={updated.transcriptionMode}
        selectedNoteIds={updated.selectedNoteIds}
        canUndo={updated.canUndo}
        canRedo={updated.canRedo}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "採譜結果" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(screen.getByRole("button", { name: "原音" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "左右比較" })).toBeDisabled();
    expect(container.querySelector("audio")).toHaveAttribute(
      "src",
      "blob:transcription-clock",
    );
    expect(
      projectStore
        .getSnapshot()
        .project!.tracks.every((track) => !track.mute && !track.solo),
    ).toBe(true);

    const playButton = screen.getByRole("button", { name: "再生" });
    await waitFor(() => expect(playButton).toBeEnabled());
    fireEvent.click(playButton);
    await waitFor(() => expect(engine.start).toHaveBeenCalledOnce());
    expect(play).toHaveBeenCalledOnce();
    expect(sourceMixerCreate).not.toHaveBeenCalled();
    expect(createObjectUrl).toHaveBeenCalledOnce();

    unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:transcription-clock");
  });

  it("resets mode state and synchronizes paired controls in comparison mode", async () => {
    const state = createCompletedSeparatedProject();

    render(
      <EditorScreen
        client={createPlaybackClient()}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={state.model}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    const sourceButton = screen.getByRole("button", { name: "原音" });
    const transcriptionButton = screen.getByRole("button", {
      name: "採譜結果",
    });
    const comparisonButton = screen.getByRole("button", { name: "左右比較" });
    const trackMute = screen.getByRole("button", { name: "Pianoをミュート" });
    const trackSolo = screen.getByRole("button", { name: "Pianoをソロ" });
    const pianoStemMute = screen.getByRole("button", {
      name: "Piano分離音源をミュート",
    });
    const pianoStemSolo = screen.getByRole("button", {
      name: "Piano分離音源をソロ",
    });
    const drumsStemMute = screen.getByRole("button", {
      name: "Drums分離音源をミュート",
    });

    await waitFor(() =>
      expect(sourceButton).toHaveAttribute("aria-pressed", "true"),
    );
    expect(trackMute).toHaveAttribute("aria-pressed", "true");
    expect(pianoStemMute).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(transcriptionButton);
    await waitFor(() =>
      expect(transcriptionButton).toHaveAttribute("aria-pressed", "true"),
    );
    expect(trackMute).toHaveAttribute("aria-pressed", "false");
    expect(pianoStemMute).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(trackSolo);
    expect(trackSolo).toHaveAttribute("aria-pressed", "true");
    expect(trackMute).toBeEnabled();
    fireEvent.click(trackMute);
    expect(trackMute).toHaveAttribute("aria-pressed", "true");
    expect(trackSolo).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(comparisonButton);
    await waitFor(() =>
      expect(comparisonButton).toHaveAttribute("aria-pressed", "true"),
    );
    expect(trackMute).toHaveAttribute("aria-pressed", "false");
    expect(trackSolo).toHaveAttribute("aria-pressed", "false");
    expect(pianoStemMute).toHaveAttribute("aria-pressed", "false");
    expect(pianoStemSolo).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(trackMute);
    expect(trackMute).toHaveAttribute("aria-pressed", "true");
    expect(pianoStemMute).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(comparisonButton);
    fireEvent.click(trackSolo);
    expect(trackSolo).toHaveAttribute("aria-pressed", "true");
    expect(pianoStemSolo).toHaveAttribute("aria-pressed", "true");
    expect(trackMute).toBeEnabled();
    expect(pianoStemMute).toBeEnabled();
    expect(drumsStemMute).toBeDisabled();
    fireEvent.click(trackMute);
    expect(trackMute).toHaveAttribute("aria-pressed", "true");
    expect(pianoStemMute).toHaveAttribute("aria-pressed", "true");
    expect(drumsStemMute).toHaveAttribute("aria-pressed", "true");
  });

  it("updates displayed controls for every mode transition without separated sources", async () => {
    const state = createChordProject(null);
    render(
      <EditorScreen
        client={createPlaybackClient()}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={state.model}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    const trackMute = screen.getByRole("button", { name: "Pianoをミュート" });
    const trackSolo = screen.getByRole("button", { name: "Pianoをソロ" });
    const original = screen.getByRole("button", { name: "原音" });
    const transcription = screen.getByRole("button", { name: "採譜結果" });
    const comparison = screen.getByRole("button", { name: "左右比較" });
    const originalAudioMute = screen.getByRole("button", {
      name: "原音のミュート状態",
    });
    const originalAudioSolo = screen.getByRole("button", {
      name: "原音のソロ状態",
    });

    await waitFor(() => expect(original).toHaveAttribute("aria-pressed", "true"));
    expect(trackMute).toHaveAttribute("aria-pressed", "true");
    expect(trackSolo).toHaveAttribute("aria-pressed", "false");
    expect(originalAudioMute).toHaveAttribute("aria-pressed", "false");
    expect(originalAudioSolo).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(transcription);
    await waitFor(() =>
      expect(transcription).toHaveAttribute("aria-pressed", "true"),
    );
    expect(trackMute).toHaveAttribute("aria-pressed", "false");
    expect(originalAudioMute).toHaveAttribute("aria-pressed", "true");
    expect(originalAudioSolo).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(trackSolo);
    expect(trackSolo).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(original);
    await waitFor(() => expect(original).toHaveAttribute("aria-pressed", "true"));
    expect(trackMute).toHaveAttribute("aria-pressed", "true");
    expect(trackSolo).toHaveAttribute("aria-pressed", "false");
    expect(originalAudioMute).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(comparison);
    await waitFor(() =>
      expect(comparison).toHaveAttribute("aria-pressed", "true"),
    );
    expect(trackMute).toHaveAttribute("aria-pressed", "false");
    expect(trackSolo).toHaveAttribute("aria-pressed", "false");
    expect(originalAudioMute).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(transcription);
    fireEvent.click(original);
    fireEvent.click(comparison);
    await waitFor(() =>
      expect(comparison).toHaveAttribute("aria-pressed", "true"),
    );
    expect(projectStore.getSnapshot().playbackSource).toBe("comparison");
    expect(trackMute).toHaveAttribute("aria-pressed", "false");
    expect(trackSolo).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("region", { name: "分離音源一覧" })).toBeNull();
  });

  it("uses track Solo only for display while original audio has no separated sources", async () => {
    const state = createChordProject(null);
    const engineCreate = vi.spyOn(SoundFontPlaybackEngine, "create");
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const { container } = render(
      <EditorScreen
        client={createPlaybackClient()}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={state.model}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    const original = screen.getByRole("button", { name: "原音" });
    const trackSolo = screen.getByRole("button", { name: "Pianoをソロ" });
    const playButton = screen.getByRole("button", { name: "再生" });
    await waitFor(() => expect(original).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(playButton).toBeEnabled());
    fireEvent.click(trackSolo);
    expect(trackSolo).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(playButton);
    fireEvent.play(container.querySelector("audio")!);
    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    expect(engineCreate).not.toHaveBeenCalled();
  });

  it("keeps the latest mode when playback configuration completes out of order", async () => {
    const state = createChordProject(null);
    const audioOutput = {
      context: {},
      destination: {},
      start: vi.fn().mockResolvedValue(undefined),
      setOutputDevice: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(PlaybackAudioOutput, "create").mockResolvedValue(
      audioOutput as unknown as PlaybackAudioOutput,
    );
    const engine = {
      setTimelineOffset: vi.fn(),
      setProject: vi.fn(),
      setSource: vi.fn(),
      setMetronome: vi.fn(),
      setTranscriptionDelayMs: vi.fn(),
      prepare: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      startAt: vi.fn(),
      currentTimelineTime: vi.fn(() => 0),
      pause: vi.fn(),
      seek: vi.fn(),
      stopNotePreview: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    let resolveEngine!: (value: SoundFontPlaybackEngine) => void;
    const engineCreation = new Promise<SoundFontPlaybackEngine>((resolve) => {
      resolveEngine = resolve;
    });
    vi.spyOn(SoundFontPlaybackEngine, "create").mockReturnValue(engineCreation);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    const { container } = render(
      <EditorScreen
        client={createPlaybackClient()}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={state.model}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );
    const audio = container.querySelector("audio")!;
    const play = screen.getByRole("button", { name: "再生" });
    const comparison = screen.getByRole("button", { name: "左右比較" });
    const transcription = screen.getByRole("button", { name: "採譜結果" });
    await waitFor(() => expect(comparison).toBeEnabled());
    fireEvent.click(play);
    fireEvent.play(audio);

    fireEvent.click(comparison);
    await waitFor(() =>
      expect(SoundFontPlaybackEngine.create).toHaveBeenCalledOnce(),
    );
    fireEvent.click(transcription);
    resolveEngine(engine as unknown as SoundFontPlaybackEngine);

    await waitFor(() =>
      expect(transcription).toHaveAttribute("aria-pressed", "true"),
    );
    await waitFor(() =>
      expect(engine.setSource).toHaveBeenLastCalledWith("transcription"),
    );
    expect(projectStore.getSnapshot().playbackSource).toBe("transcription");
    expect(SoundFontPlaybackEngine.create).toHaveBeenCalledOnce();
  });

  it("routes source audio through PCM playback when switching to comparison", async () => {
    const state = createCompletedSeparatedProject();
    const audioOutput = {
      context: {},
      destination: {},
      start: vi.fn().mockResolvedValue(undefined),
      setOutputDevice: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(PlaybackAudioOutput, "create").mockResolvedValue(
      audioOutput as unknown as PlaybackAudioOutput,
    );
    const engine = {
      setTimelineOffset: vi.fn(),
      setProject: vi.fn(),
      setSource: vi.fn(),
      setMetronome: vi.fn(),
      setTranscriptionDelayMs: vi.fn(),
      prepare: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      startAt: vi.fn(),
      currentTimelineTime: vi.fn(() => 0),
      pause: vi.fn(),
      seek: vi.fn(),
      stopNotePreview: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(SoundFontPlaybackEngine, "create").mockResolvedValue(
      engine as unknown as SoundFontPlaybackEngine,
    );
    let mixerSourceTime = 0;
    let mixerPlaying = false;
    const mixer = {
      setMode: vi.fn(),
      setVolume: vi.fn(),
      setSourceDelayMs: vi.fn(),
      setStemStates: vi.fn(),
      prepare: vi.fn().mockResolvedValue(undefined),
      primeStart: vi.fn().mockImplementation(() => {
        mixerPlaying = true;
        return Promise.resolve({
          contextTimeSec: 1,
          sourceTimeSec: mixerSourceTime,
          audibleContextTimeSec: 1.005,
        });
      }),
      activateAt: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(() => {
        mixerPlaying = false;
      }),
      seek: vi.fn((timeSec: number) => {
        mixerPlaying = false;
        mixerSourceTime = timeSec;
      }),
      currentSourceTime: vi.fn(() => mixerSourceTime),
      get isPlaying() {
        return mixerPlaying;
      },
      setEndedHandler: vi.fn(),
      setErrorHandler: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(PcmSourcePlayback, "create").mockResolvedValue(
      mixer as unknown as PcmSourcePlayback,
    );
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});

    const { container } = render(
      <EditorScreen
        client={createPlaybackClient()}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={state.model}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    const sourceAudio = container.querySelector("audio")!;
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "左右比較" })).toBeEnabled(),
    );
    fireEvent.change(screen.getByRole("slider", { name: "原音音量" }), {
      target: { value: "45" },
    });
    fireEvent.click(screen.getByRole("button", { name: "採譜結果" }));
    await waitFor(() => expect(sourceAudio.volume).toBe(0));
    fireEvent.click(screen.getByRole("button", { name: "左右比較" }));
    fireEvent.click(screen.getByRole("button", { name: "再生" }));
    await waitFor(() => expect(PcmSourcePlayback.create).toHaveBeenCalledOnce());
    await waitFor(() => expect(mixer.activateAt).toHaveBeenCalledOnce());
    expect(engine.setSource).toHaveBeenLastCalledWith("comparison");
    expect(mixer.setMode).toHaveBeenLastCalledWith("comparison");
    expect(
      engine.setProject.mock.calls.at(-1)?.[0].every(
        (track: { mute: boolean; solo: boolean }) =>
          !track.mute && !track.solo,
      ),
    ).toBe(true);
    expect(
      mixer.setStemStates.mock.calls.at(-1)?.[0].every(
        (stem: { mute: boolean; solo: boolean }) =>
          !stem.mute && !stem.solo,
      ),
    ).toBe(true);
    expect(sourceAudio.volume).toBe(0);
    fireEvent.play(sourceAudio);

    const pauseCountBeforePianoRollSeek = pause.mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "ピアノロールで5秒へシーク" }),
    );
    await waitFor(() => expect(mixer.activateAt).toHaveBeenCalledTimes(2));
    expect(pause).toHaveBeenCalledTimes(pauseCountBeforePianoRollSeek + 1);
    expect(screen.getByRole("button", { name: "一時停止" })).toBeVisible();
    expect(mixer.seek).toHaveBeenLastCalledWith(5);
    expect(mixer.primeStart).toHaveBeenLastCalledWith(5);
    expect(mixer.activateAt).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceTimeSec: 5 }),
    );

    const seekSlider = screen.getByRole("slider", { name: "再生位置" });
    fireEvent.pointerDown(seekSlider, { button: 0, pointerId: 30 });
    fireEvent.change(seekSlider, { target: { value: "6" } });
    fireEvent.pointerUp(seekSlider, { button: 0, pointerId: 30 });
    await waitFor(() => expect(mixer.activateAt).toHaveBeenCalledTimes(3));
    expect(mixer.seek).toHaveBeenLastCalledWith(6);
    expect(mixer.activateAt).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceTimeSec: 6 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "一時停止" }));
    expect(mixerPlaying).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "ピアノロールで5秒へシーク" }),
    );
    await waitFor(() => expect(mixer.seek).toHaveBeenLastCalledWith(5));
    expect(mixer.activateAt).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole("button", { name: "採譜結果" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "採譜結果" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await waitFor(() =>
      expect(engine.setSource).toHaveBeenLastCalledWith("transcription"),
    );
    expect(mixer.setMode).toHaveBeenLastCalledWith("transcription");
    expect(
      engine.setProject.mock.calls.at(-1)?.[0].every(
        (track: { mute: boolean; solo: boolean }) =>
          !track.mute && !track.solo,
      ),
    ).toBe(true);
    expect(
      mixer.setStemStates.mock.calls.at(-1)?.[0].every(
        (stem: { mute: boolean; solo: boolean }) =>
          stem.mute && !stem.solo,
      ),
    ).toBe(true);
    expect(sourceAudio.volume).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "原音" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "原音" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await waitFor(() =>
      expect(engine.setSource).toHaveBeenLastCalledWith("original"),
    );
    expect(mixer.setMode).toHaveBeenLastCalledWith("original");
    expect(
      engine.setProject.mock.calls.at(-1)?.[0].every(
        (track: { mute: boolean; solo: boolean }) =>
          track.mute && !track.solo,
      ),
    ).toBe(true);
    expect(
      mixer.setStemStates.mock.calls.at(-1)?.[0].every(
        (stem: { mute: boolean; solo: boolean }) =>
          !stem.mute && !stem.solo,
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "左右比較" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "左右比較" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(sourceAudio.volume).toBe(0);
    expect(engine.setSource).toHaveBeenLastCalledWith("comparison");
    expect(mixer.setMode).toHaveBeenLastCalledWith("comparison");
    expect(
      engine.setProject.mock.calls.at(-1)?.[0].every(
        (track: { mute: boolean; solo: boolean }) =>
          !track.mute && !track.solo,
      ),
    ).toBe(true);
    expect(
      mixer.setStemStates.mock.calls.at(-1)?.[0].every(
        (stem: { mute: boolean; solo: boolean }) =>
          !stem.mute && !stem.solo,
      ),
    ).toBe(true);
    expect(mixer.setVolume).toHaveBeenLastCalledWith(0.45);

    fireEvent.click(screen.getByRole("button", { name: "全体" }));
    fireEvent.click(screen.getByRole("button", { name: "再生" }));
    await waitFor(() => expect(mixer.activateAt).toHaveBeenCalledTimes(4));
    const endedHandler = mixer.setEndedHandler.mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    expect(endedHandler).toBeTypeOf("function");
    endedHandler?.();
    await waitFor(() => expect(mixer.activateAt).toHaveBeenCalledTimes(5));
    expect(mixer.seek).toHaveBeenLastCalledWith(0);
    expect(screen.getByRole("button", { name: "一時停止" })).toBeVisible();
  });

  it("updates and displays beat-level differences on request", async () => {
    const state = createChordProject("completed");
    const result = {
      intervals: [
        {
          startSec: 0,
          endSec: 0.5,
          measureNumber: 1,
          beatInMeasure: 1,
          value: 0.25,
        },
      ],
      minimum: 0.25,
      maximum: 0.25,
    };
    renderSpectralComparisonWav.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const calculateSpectralDifference = vi.fn().mockResolvedValue(result);
    render(
      <EditorScreen
        client={createPlaybackClient({ calculateSpectralDifference })}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={null}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    const updateButton = await screen.findByRole("button", {
      name: "不一致度の表示を更新",
    });
    expect(calculateSpectralDifference).not.toHaveBeenCalled();
    fireEvent.click(updateButton);
    await waitFor(() => expect(calculateSpectralDifference).toHaveBeenCalled());
    expect(calculateSpectralDifference).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePaths: ["D:\\audio.wav"],
        synthesizedPath: "D:\\cache\\spectral.wav",
        bpm: 120,
      }),
    );
    expect(window.desktopApi.deleteSpectralAnalysisAudio).toHaveBeenCalledWith(
      "D:\\cache\\spectral.wav",
    );
    expect(screen.getByTestId("piano-roll")).toHaveAttribute(
      "data-spectral-differences",
      "1",
    );
    expect(screen.getByText(/原音との差 \(全パート\)/)).toBeVisible();
  });

  it("updates a stale difference display only after another request", async () => {
    const state = createChordProject(null);
    const result = {
      intervals: [
        {
          startSec: 0,
          endSec: 0.5,
          measureNumber: 1,
          beatInMeasure: 1,
          value: 0.25,
        },
      ],
      minimum: 0.25,
      maximum: 0.25,
    };
    let resolveFirstCalculation: (value: typeof result) => void = () => {};
    renderSpectralComparisonWav.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const calculateSpectralDifference = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<typeof result>((resolve) => {
            resolveFirstCalculation = resolve;
          }),
      )
      .mockResolvedValue(result);
    const { rerender } = render(
      <EditorScreen
        client={createPlaybackClient({ calculateSpectralDifference })}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={null}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    const updateButton = await screen.findByRole("button", {
      name: "不一致度の表示を更新",
    });
    fireEvent.click(updateButton);
    await waitFor(() => expect(calculateSpectralDifference).toHaveBeenCalledOnce());

    const trackId = projectStore.getSnapshot().project!.tracks[0].id;
    projectStore.applyJobEvent({
      type: "note",
      id: "note-72",
      sourceInstrumentId: "acoustic_piano",
      trackId,
      pitch: 72,
      rawStartSec: 2,
      rawEndSec: 3,
      startSec: 2,
      endSec: 3,
      velocity: 100,
    });
    const updated = projectStore.getSnapshot();
    rerender(
      <EditorScreen
        client={createPlaybackClient({ calculateSpectralDifference })}
        project={updated.project!}
        hasUnsavedChanges={updated.hasUnsavedChanges}
        model={null}
        job={updated.job}
        transcriptionMode={updated.transcriptionMode}
        selectedNoteIds={updated.selectedNoteIds}
        canUndo={updated.canUndo}
        canRedo={updated.canRedo}
      />,
    );
    resolveFirstCalculation(result);

    await waitFor(() => expect(updateButton).toBeEnabled());
    expect(calculateSpectralDifference).toHaveBeenCalledOnce();
    expect(screen.getByTestId("piano-roll")).toHaveAttribute(
      "data-spectral-differences",
      "0",
    );
    fireEvent.click(updateButton);
    await waitFor(() => expect(calculateSpectralDifference).toHaveBeenCalledTimes(2));
  });

  it("follows playback, fits and shifts all notes", async () => {
    const saveProjectFile = vi
      .fn()
      .mockResolvedValue("D:\\projects\\timing.ecaproj");
    const selectExportPath = vi
      .fn()
      .mockImplementation((kind: "midi" | "musicxml") =>
        Promise.resolve(
          kind === "midi"
            ? "D:\\exports\\score.mid"
            : "D:\\exports\\score.musicxml",
        ),
      );
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getLocalAudioUrl: vi.fn().mockResolvedValue("file:///audio.wav"),
        loadSoundFont: vi.fn().mockResolvedValue(new Uint8Array()),
        saveProjectFile,
        selectExportPath,
        selectExportDirectory: vi.fn().mockResolvedValue("D:\\exports"),
        showItemInFolder: vi.fn().mockResolvedValue(undefined),
      } as unknown as DesktopApi,
    });
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const exportStems = vi.fn().mockResolvedValue([
      "D:\\exports\\drums.wav",
      "D:\\exports\\bass.wav",
      "D:\\exports\\vocals.wav",
      "D:\\exports\\other.wav",
    ]);
    const exportMusicXml = vi
      .fn()
      .mockResolvedValue("D:\\exports\\score.musicxml");
    const exportMidi = vi.fn().mockResolvedValue("D:\\exports\\score.mid");
    const validateScore = vi.fn().mockResolvedValue({
      issues: [],
      errorCount: 0,
      warningCount: 0,
    });
    const previewMusicXml = vi.fn().mockResolvedValue(
      '<score-partwise version="4.0"><part-list/></score-partwise>',
    );
    const client = createPlaybackClient({
      exportMidi,
      exportMusicXml,
      exportStems,
      validateScore,
      previewMusicXml,
    });
    projectStore.createProject({
      name: "timing",
      audio: {
        absolutePath: "D:\\audio.wav",
        sha256: "a".repeat(64),
        durationSec: 30,
        sampleRate: 44100,
        channels: 2,
        codecName: "pcm",
      },
      bpm: 120,
      beatOffsetSec: 0.1,
      numerator: 4,
      denominator: 4,
      preset: {
        id: "preset",
        key: "preset",
        name: "Piano",
        trackCount: 1,
        tracks: [
          {
            displayName: "Piano",
            instrumentId: "acoustic_piano",
            color: "#112233",
            kind: "pitched",
            order: 1,
          },
        ],
      },
      instruments: [
        {
          id: "acoustic_piano",
          displayNameJa: "ピアノ",
          kind: "pitched",
          gmProgram: 0,
          gmPrograms: [{ program: 0, displayNameJa: "ピアノ" }],
        },
      ],
    });
    const initial = projectStore.getSnapshot();
    const trackId = initial.project!.tracks[0].id;
    projectStore.beginJob("timing-job");
    projectStore.applyJobEvent({
      type: "note",
      id: "note-1",
      sourceInstrumentId: "acoustic_piano",
      trackId,
      pitch: 60,
      rawStartSec: 0.34,
      rawEndSec: 0.57,
      startSec: 0.34,
      endSec: 0.57,
      velocity: 100,
    });
    projectStore.setSelection(["note-1"]);
    for (const stem of [
      {
        type: "drums" as const,
        cachePath: "D:\\cache\\drums.wav",
        sha256: "b".repeat(64),
        sampleRate: 44100 as const,
        channels: 2 as const,
        mute: false,
        solo: false,
      },
      {
        type: "bass" as const,
        cachePath: "D:\\cache\\bass.wav",
        sha256: "c".repeat(64),
        sampleRate: 44100 as const,
        channels: 2 as const,
        mute: false,
        solo: false,
      },
      {
        type: "vocals" as const,
        cachePath: "D:\\cache\\vocals.wav",
        sha256: "d".repeat(64),
        sampleRate: 44100 as const,
        channels: 2 as const,
        mute: false,
        solo: false,
      },
      {
        type: "other" as const,
        cachePath: "D:\\cache\\other.wav",
        sha256: "e".repeat(64),
        sampleRate: 44100 as const,
        channels: 2 as const,
        mute: false,
        solo: false,
      },
      {
        type: "piano" as const,
        cachePath: "D:\\cache\\piano.wav",
        sha256: "f".repeat(64),
        sampleRate: 44100 as const,
        channels: 2 as const,
        mute: false,
        solo: false,
      },
      {
        type: "guitar" as const,
        cachePath: "D:\\cache\\guitar.wav",
        sha256: "a".repeat(64),
        sampleRate: 44100 as const,
        channels: 2 as const,
        mute: false,
        solo: false,
      },
    ]) {
      projectStore.applyJobEvent({ type: "stem", stem });
    }
    const state = projectStore.getSnapshot();
    const projectWithStems = state.project!;
    const { container, rerender } = render(
      <EditorScreen
        client={client}
        project={projectWithStems}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={null}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    expect(screen.getByRole("button", { name: "設定" })).toBeInTheDocument();
    expect(
      screen.queryByLabelText("オーディオ出力デバイス"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("piano-roll")).toHaveAttribute(
      "data-editing-locked",
      "true",
    );
    expect(screen.getByLabelText("BPM")).toBeDisabled();
    const drawTool = screen.getByRole("button", { name: "描画ツール" });
    expect(drawTool).toBeEnabled();
    fireEvent.click(drawTool);
    expect(screen.getByLabelText("移動先トラック")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "選択ツール" }));
    projectStore.applyJobEvent({ type: "state", status: "completed" });
    const completedState = projectStore.getSnapshot();
    rerender(
      <EditorScreen
        client={client}
        project={completedState.project!}
        hasUnsavedChanges={completedState.hasUnsavedChanges}
        model={null}
        job={completedState.job}
        transcriptionMode={completedState.transcriptionMode}
        selectedNoteIds={completedState.selectedNoteIds}
        canUndo={completedState.canUndo}
        canRedo={completedState.canRedo}
      />,
    );
    expect(screen.getByTestId("piano-roll")).toHaveAttribute(
      "data-editing-locked",
      "false",
    );
    expect(screen.getByLabelText("BPM")).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "選択ツール" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "描画ツール" }));
    expect(screen.getByLabelText("移動先トラック")).toHaveValue(trackId);
    fireEvent.click(screen.getByRole("button", { name: "選択ツール" }));

    const startBeforeTranspose =
      projectStore.getSnapshot().project!.notes[0].startSec;
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(projectStore.getSnapshot().project!.notes[0]).toMatchObject({
      pitch: 61,
      startSec: startBeforeTranspose,
    });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(projectStore.getSnapshot().project!.notes[0].pitch).toBe(60);
    expect(screen.getByTestId("piano-roll")).toHaveAttribute(
      "data-follow",
      "false",
    );
    const audio = container.querySelector("audio")!;
    expect(audio).toHaveAttribute("preload", "auto");
    const originalVolume = screen.getByRole("slider", { name: "原音音量" });
    expect(originalVolume).toHaveValue("100");
    fireEvent.change(originalVolume, { target: { value: "45" } });
    expect(audio.volume).toBeCloseTo(0.45);
    expect(window.localStorage.getItem("earcopy-original-volume")).toBe("45");
    audio.defaultPlaybackRate = 0.5;
    audio.playbackRate = 0.5;
    audio.preservesPitch = false;
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "再生" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "再生" }));
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(audio.defaultPlaybackRate).toBe(1);
    expect(audio.playbackRate).toBe(1);
    expect(audio.preservesPitch).toBe(true);
    fireEvent.play(audio);
    expect(screen.getByTestId("piano-roll")).toHaveAttribute(
      "data-follow",
      "true",
    );
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(pause).toHaveBeenCalled();
    fireEvent.pause(audio);
    const playCountBeforeSpace = play.mock.calls.length;
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    await waitFor(() =>
      expect(play).toHaveBeenCalledTimes(playCountBeforeSpace + 1),
    );
    const bpmInput = screen.getByLabelText("BPM");
    fireEvent.keyDown(bpmInput, { key: " ", code: "Space" });
    expect(play).toHaveBeenCalledTimes(playCountBeforeSpace + 1);

    const selectedTool = screen.getByRole("button", { name: "選択ツール" });
    selectedTool.focus();
    const playCountBeforeSelectedButtonSpace = play.mock.calls.length;
    expect(
      fireEvent.keyDown(selectedTool, { key: " ", code: "Space" }),
    ).toBe(false);
    await waitFor(() =>
      expect(play).toHaveBeenCalledTimes(
        playCountBeforeSelectedButtonSpace + 1,
      ),
    );
    expect(selectedTool).toHaveAttribute("aria-pressed", "true");

    const unselectedTool = screen.getByRole("button", { name: "描画ツール" });
    unselectedTool.focus();
    const playCountBeforeUnselectedButtonSpace = play.mock.calls.length;
    expect(
      fireEvent.keyDown(unselectedTool, { key: " ", code: "Space" }),
    ).toBe(false);
    await waitFor(() =>
      expect(play).toHaveBeenCalledTimes(
        playCountBeforeUnselectedButtonSpace + 1,
      ),
    );
    expect(unselectedTool).toHaveAttribute("aria-pressed", "false");

    expect(
      screen.getByRole("tab", { name: "トラック" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("button", { name: "Pianoをミュート" }),
    ).toBeEnabled();
    fireEvent.change(
      screen.getByRole("slider", { name: "Pianoの再生音量" }),
      { target: { value: "42" } },
    );
    expect(
      projectStore.getSnapshot().project?.tracks[0].playbackVolume,
    ).toBe(42);
    fireEvent.click(screen.getByRole("tab", { name: "編集" }));
    expect(
      screen.getByRole("tab", { name: "編集" }),
    ).toHaveAttribute("aria-selected", "true");

    fireEvent.click(
      screen.getByRole("button", { name: "テンポを2倍" }),
    );
    expect(projectStore.getSnapshot().project?.tempo.bpm).toBe(240);
    fireEvent.click(
      screen.getByRole("button", { name: "テンポを半分" }),
    );
    expect(projectStore.getSnapshot().project?.tempo.bpm).toBe(120);

    fireEvent.click(screen.getByText("拍位置にフィット"));
    expect(
      projectStore.getSnapshot().project?.notes[0].startSec,
    ).toBeCloseTo(0.35);

    fireEvent.click(
      screen.getByRole("button", {
        name: "選択ノートを小節先頭に設定",
      }),
    );
    expect(
      projectStore.getSnapshot().project?.tempo.beatOffsetSec,
    ).toBeCloseTo(0.35);
    expect(
      projectStore.getSnapshot().project?.sourceAudio.timelineOffsetSec,
    ).toBe(0);

    fireEvent.click(
      screen.getByRole("button", { name: "全ノートを半拍後へ" }),
    );
    expect(
      projectStore.getSnapshot().project?.notes[0].startSec,
    ).toBeCloseTo(0.6);
    expect(
      projectStore.getSnapshot().project?.sourceAudio.timelineOffsetSec,
    ).toBeCloseTo(0.25);

    fireEvent.change(screen.getByLabelText("ノート位置補正ミリ秒"), {
      target: { value: "-50" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^移動$/ }));
    expect(
      projectStore.getSnapshot().project?.notes[0].startSec,
    ).toBeCloseTo(0.55);
    expect(
      projectStore.getSnapshot().project?.sourceAudio.timelineOffsetSec,
    ).toBeCloseTo(0.2);

    const editedState = projectStore.getSnapshot();
    rerender(
      <EditorScreen
        client={client}
        project={editedState.project!}
        hasUnsavedChanges={editedState.hasUnsavedChanges}
        model={editedState.model}
        job={editedState.job}
        transcriptionMode={editedState.transcriptionMode}
        selectedNoteIds={editedState.selectedNoteIds}
        canUndo={editedState.canUndo}
        canRedo={editedState.canRedo}
      />,
    );
    expect(screen.getByTestId("piano-roll")).toHaveAttribute(
      "data-duration",
      "30.2",
    );
    audio.currentTime = 2;
    fireEvent.timeUpdate(audio);
    expect(screen.getByTestId("piano-roll")).toHaveAttribute(
      "data-playhead",
      "2.2",
    );
    const seekSlider = screen.getByLabelText("再生位置");
    fireEvent.play(audio);
    const pauseCountBeforeSeek = pause.mock.calls.length;
    const playCountBeforeSeek = play.mock.calls.length;
    fireEvent.pointerDown(seekSlider, { button: 0, pointerId: 21 });
    expect(pause).toHaveBeenCalledTimes(pauseCountBeforeSeek + 1);
    fireEvent.change(seekSlider, {
      target: { value: "2.7" },
    });
    fireEvent.change(seekSlider, {
      target: { value: "3.2" },
    });
    expect(play).toHaveBeenCalledTimes(playCountBeforeSeek);
    expect(audio.currentTime).toBeCloseTo(3);
    fireEvent.pointerUp(seekSlider, { button: 0, pointerId: 21 });
    await waitFor(() =>
      expect(play).toHaveBeenCalledTimes(playCountBeforeSeek + 1),
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saveProjectFile).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(projectStore.getSnapshot().hasUnsavedChanges).toBe(false),
    );
    const savedProject = JSON.parse(saveProjectFile.mock.calls[0][1]);
    expect(savedProject.notes[0].startSec).toBeCloseTo(0.55);
    expect(savedProject.tempo.beatOffsetSec).toBeCloseTo(0.35);
    expect(savedProject.sourceAudio.timelineOffsetSec).toBeCloseTo(0.2);
    expect(savedProject.tracks[0].playbackVolume).toBe(42);

    fireEvent.click(screen.getByRole("button", { name: "書き出し" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^MIDI/ }));
    await waitFor(() => expect(exportMidi).toHaveBeenCalledOnce());
    expect(exportMidi.mock.calls[0][0].notes[0].startSec).toBeCloseTo(0.55);
    expect(exportMidi.mock.calls[0][0].tempo.beatOffsetSec).toBeCloseTo(0.35);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "書き出し" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^MusicXML/ }));
    const musicXmlExportButton = await screen.findByRole("button", {
      name: "MusicXML書き出し",
    });
    fireEvent.change(screen.getByLabelText("書き出す音符の分解能"), {
      target: { value: "1/4" },
    });
    expect(musicXmlExportButton).toBeDisabled();
    await waitFor(() => expect(musicXmlExportButton).toBeEnabled());
    fireEvent.click(musicXmlExportButton);
    await waitFor(() => expect(exportMusicXml).toHaveBeenCalledOnce());
    const exportedProject = exportMusicXml.mock.calls[0][0];
    expect(exportedProject.notes[0].startSec).toBeCloseTo(0.35);
    expect(exportedProject.tempo.quantizeGrid).toBe("1/4");
    expect(exportedProject.tempo.beatOffsetSec).toBeCloseTo(0.35);

    fireEvent.click(screen.getByRole("button", { name: "書き出し" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^分離音源/ }));
    await waitFor(() => expect(exportStems).toHaveBeenCalledOnce());
    const stemProject = exportStems.mock.calls[0][0];
    expect(stemProject.notes[0].startSec).toBeCloseTo(0.55);
    expect(stemProject.stems).toHaveLength(6);
    expect(exportStems.mock.calls[0][1]).toBe("D:\\exports");
    expect(window.desktopApi.showItemInFolder).toHaveBeenCalledWith(
      "D:\\exports\\drums.wav",
    );

    const soloTrackId = projectStore.getSnapshot().project!.tracks[0].id;
    projectStore.selectPlaybackSource("original");
    projectStore.togglePlaybackTrackSolo(soloTrackId);
    fireEvent.click(screen.getByRole("button", { name: "採譜結果" }));
    const transcriptionProject = projectStore.getSnapshot().project!;
    expect(
      transcriptionProject.tracks.every(
        (track) => !track.mute && !track.solo,
      ),
    ).toBe(true);
    expect(
      transcriptionProject.stems.every(
        (stem) => stem.mute && !stem.solo,
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "左右比較" }));
    const comparisonProject = projectStore.getSnapshot().project!;
    expect(
      [...comparisonProject.tracks, ...comparisonProject.stems].every(
        (item) => !item.mute && !item.solo,
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "原音" }));
    const originalProject = projectStore.getSnapshot().project!;
    expect(
      originalProject.tracks.every((track) => track.mute && !track.solo),
    ).toBe(true);
    expect(
      originalProject.stems.every((stem) => !stem.mute && !stem.solo),
    ).toBe(true);
  }, 10_000);

  it("shows source-separation progress and estimated remaining time until all stems exist", async () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getLocalAudioUrl: vi.fn().mockResolvedValue("file:///audio.wav"),
        loadSoundFont: vi.fn().mockResolvedValue(new Uint8Array()),
      } as unknown as DesktopApi,
    });
    projectStore.createProject({
      name: "stems",
      audio: {
        absolutePath: "D:\\audio.wav",
        sha256: "a".repeat(64),
        durationSec: 30,
        sampleRate: 44100,
        channels: 2,
        codecName: "pcm",
      },
      bpm: 120,
      numerator: 4,
      denominator: 4,
      mode: "separated",
      preset: {
        id: "preset",
        key: "preset",
        name: "Piano",
        trackCount: 1,
        tracks: [
          {
            displayName: "Piano",
            instrumentId: "acoustic_piano",
            color: "#112233",
            kind: "pitched",
            order: 1,
          },
        ],
      },
      instruments: [
        {
          id: "acoustic_piano",
          displayNameJa: "ピアノ",
          kind: "pitched",
          gmProgram: 0,
          gmPrograms: [{ program: 0, displayNameJa: "ピアノ" }],
        },
      ],
    });
    projectStore.beginJob("stem-job");
    projectStore.applyJobEvent({ type: "state", status: "separating" });
    projectStore.applyJobEvent({
      type: "progress",
      stage: "separating",
      completed: 0,
      total: 4,
    });
    const performanceNow = vi.spyOn(performance, "now").mockReturnValue(0);
    let state = projectStore.getSnapshot();
    const client = createPlaybackClient();
    const view = render(
      <EditorScreen
        client={client}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={null}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    expect(screen.getByRole("heading", { name: "音源を分離中" })).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "音源分離進捗" }))
      .toHaveValue(0);
    expect(screen.getByText("推定残り時間を計算中")).toBeVisible();
    expect(screen.getByText(
      "drums / bass / vocals / piano / guitar / other",
    )).toBeVisible();
    expect(
      view.container.querySelector('[data-testid="piano-roll"]'),
    ).toBeNull();

    performanceNow.mockReturnValue(4_000);
    projectStore.applyJobEvent({
      type: "progress",
      stage: "separating",
      completed: 1,
      total: 4,
    });
    state = projectStore.getSnapshot();
    view.rerender(
      <EditorScreen
        client={client}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={null}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("推定残り時間: 約15秒")).toBeVisible(),
    );
    expect(screen.getByRole("progressbar", { name: "音源分離進捗" }))
      .toHaveValue(25);

    for (const [index, type] of [
      "drums",
      "bass",
      "vocals",
      "other",
      "piano",
      "guitar",
    ].entries()) {
      projectStore.applyJobEvent({
        type: "stem",
        stem: {
          type: type as
            | "drums"
            | "bass"
            | "vocals"
            | "other"
            | "piano"
            | "guitar",
          cachePath: `D:\\cache\\${type}.wav`,
          sha256: `${index + 1}`.repeat(64),
          sampleRate: 44100,
          channels: 2,
          mute: false,
          solo: false,
        },
      });
    }
    state = projectStore.getSnapshot();
    view.rerender(
      <EditorScreen
        client={client}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={null}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    expect(
      view.container.querySelector('[data-testid="piano-roll"]'),
    ).not.toBeNull();

    projectStore.applyJobEvent({
      type: "progress",
      stage: "transcribing",
      completed: 2,
      total: 8,
      transcriptionInputName: "bass",
      transcriptionPass: "separated_audio",
      inputPassIndex: 2,
      inputPassCount: 2,
    });
    state = projectStore.getSnapshot();
    view.rerender(
      <EditorScreen
        client={client}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={null}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );
    expect(
      screen.getByText("ベース（分離音源、2/2）を採譜中"),
    ).toBeVisible();
  });

  it("applies saved transcription inputs without starting transcription", async () => {
    const state = createCompletedSeparatedProject();
    const startTranscription = vi.fn();
    const applySavedTranscriptionOptions = vi.fn(
      () => new Promise<never>(() => undefined),
    );
    const client = createPlaybackClient({
      startTranscription,
      applySavedTranscriptionOptions,
    });

    render(
      <EditorScreen
        client={client}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={state.model}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        separatedSettings={state.separatedSettings}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    const paneToggle = screen.getByRole("button", { name: "採譜オプション" });
    expect(
      screen.getByRole("complementary", { name: "採譜オプション" }),
    ).toBeVisible();
    fireEvent.click(paneToggle);
    expect(
      screen.queryByRole("complementary", { name: "採譜オプション" }),
    ).toBeNull();
    fireEvent.click(paneToggle);

    const option = screen.getByLabelText(
      /ドラム成分の追加による音高の誤検出を削減する/,
    );
    expect(within(option.closest("label")!).getByText("有効")).toBeVisible();
    fireEvent.click(option);

    await waitFor(() =>
      expect(applySavedTranscriptionOptions).toHaveBeenCalledOnce(),
    );
    expect(startTranscription).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "採譜結果更新: 保存済みの採譜入力別ノートを処理しています",
      ),
    ).toBeVisible();
    expect(screen.queryByText("採譜完了")).toBeNull();
  });

  it("updates stem-amplitude velocity without starting transcription", async () => {
    const state = createCompletedSeparatedProject();
    const startTranscription = vi.fn();
    let completeVelocityUpdate!: (notes: []) => void;
    const velocityUpdate = new Promise<[]>((resolve) => {
      completeVelocityUpdate = resolve;
    });
    const applyStemAmplitudeVelocitySetting = vi
      .fn()
      .mockReturnValue(velocityUpdate);
    const client = createPlaybackClient({
      startTranscription,
      applyStemAmplitudeVelocitySetting,
    });

    render(
      <EditorScreen
        client={client}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={state.model}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        separatedSettings={state.separatedSettings}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    const option = screen.getByLabelText(
      /分離後音源の音量からベロシティを設定する/,
    );
    fireEvent.click(option);

    await waitFor(() =>
      expect(applyStemAmplitudeVelocitySetting).toHaveBeenCalledOnce(),
    );
    expect(startTranscription).not.toHaveBeenCalled();
    expect(screen.getByText(/^採譜結果更新:/)).toBeVisible();

    completeVelocityUpdate([]);
    await waitFor(() =>
      expect(screen.queryByText(/^採譜結果更新:/)).toBeNull(),
    );
    expect(
      projectStore.getSnapshot().project?.transcription
        ?.velocityFromStemAmplitude,
    ).toBe(false);
  });

  it("confirms before discarding unsaved project changes", async () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getLocalAudioUrl: vi.fn().mockResolvedValue("file:///audio.wav"),
        loadSoundFont: vi.fn().mockResolvedValue(new Uint8Array()),
      } as unknown as DesktopApi,
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    projectStore.createProject({
      name: "unsaved",
      audio: {
        absolutePath: "D:\\audio.wav",
        sha256: "a".repeat(64),
        durationSec: 30,
        sampleRate: 44100,
        channels: 2,
        codecName: "pcm",
      },
      bpm: 120,
      numerator: 4,
      denominator: 4,
      preset: {
        id: "preset",
        key: "preset",
        name: "Piano",
        trackCount: 1,
        tracks: [
          {
            displayName: "Piano",
            instrumentId: "acoustic_piano",
            color: "#112233",
            kind: "pitched",
            order: 1,
          },
        ],
      },
      instruments: [
        {
          id: "acoustic_piano",
          displayNameJa: "ピアノ",
          kind: "pitched",
          gmProgram: 0,
          gmPrograms: [{ program: 0, displayNameJa: "ピアノ" }],
        },
      ],
    });
    const state = projectStore.getSnapshot();

    render(
      <EditorScreen
        client={createPlaybackClient()}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={null}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    expect(screen.getByText("未保存の変更あり")).toBeVisible();
    const unloadEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unloadEvent);
    expect(unloadEvent.defaultPrevented).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: /EarCopy Assist/ }),
    );
    expect(projectStore.getSnapshot().project).not.toBeNull();

    confirm.mockReturnValue(true);
    fireEvent.click(
      screen.getByRole("button", { name: /EarCopy Assist/ }),
    );
    await waitFor(() => expect(projectStore.getSnapshot().project).toBeNull());
  });

  it("shows chord analysis progress after transcription completes", async () => {
    const state = createChordProject("completed");

    const view = render(
      <EditorScreen
        client={createPlaybackClient()}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={null}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    expect(screen.getByText("コード解析中")).toBeVisible();
    expect(screen.getByText("推定残り時間を計算中")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "コード解析進捗" }))
      .toBeVisible();
    await waitFor(() => expect(screen.getByText("採譜完了")).toBeVisible());
    expect(
      screen.queryByRole("progressbar", { name: "コード解析進捗" }),
    ).toBeNull();
    expect(screen.getByTestId("piano-roll").getAttribute("data-chords"))
      .toContain("1:C");

    projectStore.setSelection(["note-60", "note-64", "note-67"]);
    projectStore.moveSelectedNotesInTime(2);
    const editedState = projectStore.getSnapshot();
    view.rerender(
      <EditorScreen
        client={createPlaybackClient()}
        project={editedState.project!}
        hasUnsavedChanges={editedState.hasUnsavedChanges}
        model={null}
        job={editedState.job}
        transcriptionMode={editedState.transcriptionMode}
        selectedNoteIds={editedState.selectedNoteIds}
        canUndo={editedState.canUndo}
        canRedo={editedState.canRedo}
      />,
    );

    expect(screen.getByText("コード解析中")).toBeVisible();
    expect(screen.getByTestId("piano-roll")).toHaveAttribute(
      "data-chords",
      "",
    );
    await waitFor(() => expect(screen.getByText("採譜完了")).toBeVisible());
    expect(screen.getByTestId("piano-roll").getAttribute("data-chords"))
      .toContain("2:C");
    expect(screen.getByTestId("piano-roll").getAttribute("data-chords"))
      .not.toContain("1:C");
  });

  it("selects every visible note with Ctrl+A except while editing a field", () => {
    const state = createChordProject("completed");
    projectStore.clearSelection();

    render(
      <EditorScreen
        client={createPlaybackClient()}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={null}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    fireEvent.keyDown(window, { key: "a", code: "KeyA", ctrlKey: true });
    expect([...projectStore.getSnapshot().selectedNoteIds].sort()).toEqual([
      "note-60",
      "note-64",
      "note-67",
    ]);

    projectStore.clearSelection();
    fireEvent.keyDown(screen.getByLabelText("BPM"), {
      key: "a",
      code: "KeyA",
      ctrlKey: true,
    });
    expect(projectStore.getSnapshot().selectedNoteIds.size).toBe(0);
  });

  it("unlocks editing and analyzes partial notes after cancellation", async () => {
    const state = createChordProject("cancelled");

    render(
      <EditorScreen
        client={createPlaybackClient()}
        project={state.project!}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={null}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />,
    );

    expect(screen.getByTestId("piano-roll")).toHaveAttribute(
      "data-editing-locked",
      "false",
    );
    expect(screen.getByLabelText("BPM")).toBeEnabled();
    expect(screen.getByText("コード解析中")).toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: "コード解析進捗" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByText("キャンセル済み")).toBeVisible(),
    );
    expect(screen.getByTestId("piano-roll").getAttribute("data-chords"))
      .toContain("1:C");
  });
});
