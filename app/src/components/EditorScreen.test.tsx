import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalApiClient } from "../api";
import { projectStore } from "../store/project-store";
import type { DesktopApi } from "../types";
import { EditorScreen } from "./EditorScreen";

vi.mock("../services/transcription-controller", () => ({
  startProjectTranscription: vi.fn().mockResolvedValue(undefined),
  cancelProjectTranscription: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./PianoRollCanvas", () => ({
  PianoRollCanvas: ({ followPlayhead }: { followPlayhead: boolean }) => (
    <div data-testid="piano-roll" data-follow={String(followPlayhead)} />
  ),
}));

describe("EditorScreen timing controls", () => {
  afterEach(() => {
    if (projectStore.getSnapshot().project !== null) {
      projectStore.closeProject();
    }
    vi.restoreAllMocks();
  });

  it("follows playback, reanalyzes beat phase, fits and shifts all notes", async () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getLocalAudioUrl: vi.fn().mockResolvedValue("file:///audio.wav"),
        loadSoundFont: vi.fn().mockResolvedValue(new Uint8Array()),
        selectExportDirectory: vi.fn().mockResolvedValue("D:\\exports"),
        showItemInFolder: vi.fn().mockResolvedValue(undefined),
      } as unknown as DesktopApi,
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const estimateTempo = vi.fn().mockResolvedValue({
      bpm: 120,
      sampleRate: 22050,
      beatOffsetSec: 0.1,
    });
    const exportStems = vi.fn().mockResolvedValue([
      "D:\\exports\\drums.wav",
      "D:\\exports\\bass.wav",
      "D:\\exports\\vocals.wav",
      "D:\\exports\\other.wav",
    ]);
    const client = { estimateTempo, exportStems } as unknown as LocalApiClient;
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
      bpm: 100,
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
    const state = projectStore.getSnapshot();
    const projectWithStems = {
      ...state.project!,
      stems: [
        {
          type: "drums" as const,
          cachePath: "D:\\cache\\drums.wav",
          sha256: "b".repeat(64),
          sampleRate: 44100 as const,
          channels: 2 as const,
        },
        {
          type: "bass" as const,
          cachePath: "D:\\cache\\bass.wav",
          sha256: "c".repeat(64),
          sampleRate: 44100 as const,
          channels: 2 as const,
        },
        {
          type: "vocals" as const,
          cachePath: "D:\\cache\\vocals.wav",
          sha256: "d".repeat(64),
          sampleRate: 44100 as const,
          channels: 2 as const,
        },
        {
          type: "other" as const,
          cachePath: "D:\\cache\\other.wav",
          sha256: "e".repeat(64),
          sampleRate: 44100 as const,
          channels: 2 as const,
        },
      ],
    };
    const { container } = render(
      <EditorScreen
        client={client}
        project={projectWithStems}
        model={null}
        job={state.job}
        selectedNoteIds={state.selectedNoteIds}
      />,
    );

    expect(screen.getByTestId("piano-roll")).toHaveAttribute(
      "data-follow",
      "false",
    );
    const audio = container.querySelector("audio")!;
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

    fireEvent.click(screen.getByText("テンポ再解析"));
    await waitFor(() => expect(estimateTempo).toHaveBeenCalledWith("D:\\audio.wav"));
    expect(projectStore.getSnapshot().project?.tempo.bpm).toBe(120);
    expect(projectStore.getSnapshot().project?.tempo.beatOffsetSec).toBe(0.1);

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

    fireEvent.change(screen.getByLabelText("ノート位置補正ミリ秒"), {
      target: { value: "-50" },
    });
    fireEvent.click(screen.getByText("移動"));
    expect(
      projectStore.getSnapshot().project?.notes[0].startSec,
    ).toBeCloseTo(0.3);

    fireEvent.click(screen.getByText("分離WAVを保存"));
    await waitFor(() =>
      expect(exportStems).toHaveBeenCalledWith(
        projectWithStems,
        "D:\\exports",
      ),
    );
    expect(window.desktopApi.showItemInFolder).toHaveBeenCalledWith(
      "D:\\exports\\drums.wav",
    );
  });
});
