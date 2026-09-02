import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalApiClient } from "../api";
import { projectStore } from "../store/project-store";
import type {
  BackendCapability,
  DesktopApi,
  InstrumentDefinition,
  ModelProfile,
  PresetDefinition,
  StemSeparationCapability,
} from "../types";
import { NewProjectScreen } from "./NewProjectScreen";
import { LanguageProvider } from "../i18n";

beforeEach(() => {
  projectStore.closeProject();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  projectStore.closeProject();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const instruments: InstrumentDefinition[] = [
  {
    id: "acoustic_piano",
    displayNameJa: "ピアノ",
    kind: "pitched",
    gmProgram: 0,
    gmPrograms: [{ program: 0, displayNameJa: "ピアノ" }],
  },
];
const presets: PresetDefinition[] = [
  {
    id: "preset-1",
    key: "piano",
    name: "ピアノ",
    trackCount: 1,
    tracks: [
      {
        displayName: "ピアノ",
        instrumentId: "acoustic_piano",
        color: "#4f86d9",
        kind: "pitched",
        order: 1,
      },
    ],
  },
];
const models: ModelProfile[] = [];
const registeredModel: ModelProfile = {
  id: "model-1",
  profileName: "Large",
  modelPath: "D:\\models\\muscriptor\\large\\model.safetensors",
  fileName: "model.safetensors",
  sha256: "a".repeat(64),
  variant: "large",
  dtype: "float16",
  defaultBackend: "Auto",
};
const backends: BackendCapability[] = [
  { id: "Auto", available: true, reason: "CPU" },
  { id: "CPU", available: true, reason: "CPU" },
  { id: "CUDA", available: false, reason: "GPUなし" },
];
const availableStemSeparation: StemSeparationCapability = {
  available: true,
  modelDirectory: "D:\\EarCopyAssist\\models\\bs-roformer\\sw-fixed",
  modelName: "BS-RoFormer SW Fixed",
  modelFileName: "BS-Rofo-SW-Fixed.ckpt",
  modelSizeBytes: 699_412_152,
  modelSha256:
    "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e",
  licenseStatus: "Unknown",
  sourcePageUrl:
    "https://huggingface.co/jarredou/BS-ROFO-SW-Fixed/tree/ad54168acf271482ad51702953e162a385b8fdcb",
  reason: "",
};

function renderScreen(
  stemSeparation: Partial<StemSeparationCapability>,
  availableModels: ModelProfile[] = models,
) {
  const capability: StemSeparationCapability = {
    ...availableStemSeparation,
    ...stemSeparation,
  };
  render(
    <LanguageProvider>
      <NewProjectScreen
        client={{} as LocalApiClient}
        instruments={instruments}
        presets={presets}
        models={availableModels}
        backends={backends}
        stemSeparation={capability}
        onModelsChange={vi.fn()}
        onPresetsChange={vi.fn()}
      />
    </LanguageProvider>,
  );
}

describe("NewProjectScreen stem separation", () => {
  it("changes the new-project screen language", () => {
    renderScreen({});

    fireEvent.change(screen.getByLabelText("Language"), {
      target: { value: "zh" },
    });

    expect(screen.getByRole("heading", { name: "新建项目" })).toBeVisible();
    expect(screen.getByText("项目名称")).toBeVisible();
    expect(window.localStorage.getItem("earcopy-display-language")).toBe("zh");
  });

  it("restores the previous source selection", () => {
    render(
      <NewProjectScreen
        client={{} as LocalApiClient}
        instruments={instruments}
        presets={presets}
        models={models}
        backends={backends}
        stemSeparation={availableStemSeparation}
        initialSourceSelection={{
          audio: {
            absolutePath: "D:\\music\\previous-song.wav",
            sha256: "c".repeat(64),
            durationSec: 75.5,
            sampleRate: 48000,
            channels: 2,
            codecName: "pcm_s16le",
          },
          name: "前回の曲",
          bpm: 137.5,
          beatOffsetSec: 0.24,
        }}
        onModelsChange={vi.fn()}
        onPresetsChange={vi.fn()}
      />,
    );

    expect(screen.getByText("previous-song")).toBeVisible();
    expect(screen.getByLabelText("プロジェクト名")).toHaveValue("前回の曲");
    expect(screen.getByLabelText("BPM")).toHaveValue(137.5);
  });

  it("defaults to high-accuracy transcription and offers fast transcription", () => {
    renderScreen({});

    expect(screen.getByLabelText("採譜モード")).toHaveValue("high_accuracy");
    expect(screen.getByRole("option", { name: "高精度" })).toBeEnabled();
    expect(screen.getByRole("option", { name: "高速" })).toBeEnabled();
  });

  it("updates the measure position after a time-signature change", async () => {
    const estimateTempo = vi.fn().mockResolvedValue({
      bpm: 137.5,
      sampleRate: 22050,
      beatOffsetSec: 0.42,
    });
    render(
      <NewProjectScreen
        client={{ estimateTempo } as unknown as LocalApiClient}
        instruments={instruments}
        presets={presets}
        models={[registeredModel]}
        backends={backends}
        stemSeparation={availableStemSeparation}
        initialSourceSelection={{
          audio: {
            absolutePath: "D:\\music\\song.wav",
            sha256: "c".repeat(64),
            durationSec: 75.5,
            sampleRate: 48000,
            channels: 2,
            codecName: "pcm_s16le",
          },
          name: "曲",
          bpm: 137.5,
          beatOffsetSec: 0.24,
        }}
        onModelsChange={vi.fn()}
        onPresetsChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("拍子の分母"), {
      target: { value: "8" },
    });

    await waitFor(() =>
      expect(estimateTempo).toHaveBeenCalledWith(
        "D:\\music\\song.wav",
        4,
        8,
      ),
    );
    const numeratorInput = screen.getByLabelText("拍子の分子");
    fireEvent.change(numeratorInput, { target: { value: "3" } });
    fireEvent.blur(numeratorInput);
    await waitFor(() =>
      expect(estimateTempo).toHaveBeenCalledWith(
        "D:\\music\\song.wav",
        3,
        8,
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "採譜を開始" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "採譜を開始" }));

    expect(projectStore.getSnapshot().project?.tempo).toMatchObject({
      bpm: 137.5,
      beatOffsetSec: 0.42,
      timeSignature: { numerator: 3, denominator: 8 },
    });
  });

  it("stores the selected fast transcription mode in the new project", async () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        selectAudioFile: vi.fn().mockResolvedValue("D:\\music\\song.wav"),
      } as unknown as DesktopApi,
    });
    const estimateTempo = vi.fn().mockResolvedValue({
      bpm: 120,
      beatOffsetSec: 0,
    });
    const client = {
      inspectAudio: vi.fn().mockResolvedValue({
        absolutePath: "D:\\music\\song.wav",
        sha256: "b".repeat(64),
        durationSec: 30,
        sampleRate: 48000,
        channels: 2,
        codecName: "pcm_s16le",
      }),
      estimateTempo,
    } as unknown as LocalApiClient;
    render(
      <NewProjectScreen
        client={client}
        instruments={instruments}
        presets={presets}
        models={[registeredModel]}
        backends={backends}
        stemSeparation={availableStemSeparation}
        onModelsChange={vi.fn()}
        onPresetsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /音源ファイルを選択/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /採譜を開始/ })).toBeEnabled(),
    );
    expect(estimateTempo).toHaveBeenCalledWith("D:\\music\\song.wav", 4, 4);
    fireEvent.change(screen.getByLabelText("採譜モード"), {
      target: { value: "fast" },
    });
    fireEvent.click(screen.getByRole("button", { name: /採譜を開始/ }));

    expect(projectStore.getSnapshot().transcriptionProfile).toBe("fast");
  });

  it("opens a saved project without reading its source audio file", async () => {
    projectStore.createProject({
      name: "保存済みプロジェクト",
      audio: {
        absolutePath: "D:\\deleted\\source.wav",
        sha256: "a".repeat(64),
        durationSec: 30,
        sampleRate: 48000,
        channels: 2,
        codecName: "pcm_s16le",
      },
      bpm: 137,
      beatOffsetSec: 0.24,
      numerator: 4,
      denominator: 4,
      preset: presets[0],
      instruments,
    });
    const trackId = projectStore.getSnapshot().project!.tracks[0].id;
    projectStore.setPlaybackVolume(trackId, 42);
    const savedProject = projectStore.getSnapshot().project!;
    projectStore.closeProject();
    const loadProject = vi.fn().mockResolvedValue(savedProject);
    const estimateTempo = vi.fn();
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        selectProjectFile: vi.fn().mockResolvedValue("D:\\projects\\song.ecaproj"),
      } as unknown as DesktopApi,
    });
    render(
      <NewProjectScreen
        client={{ loadProject, estimateTempo } as unknown as LocalApiClient}
        instruments={instruments}
        presets={presets}
        models={models}
        backends={backends}
        stemSeparation={availableStemSeparation}
        onModelsChange={vi.fn()}
        onPresetsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: ".ecaprojを開く" }));

    await waitFor(() =>
      expect(projectStore.getSnapshot().screen).toBe("editor"),
    );
    expect(loadProject).toHaveBeenCalledWith("D:\\projects\\song.ecaproj");
    expect(estimateTempo).not.toHaveBeenCalled();
    expect(projectStore.getSnapshot().project?.tempo).toMatchObject({
      bpm: 137,
      beatOffsetSec: 0.24,
    });
    expect(
      projectStore.getSnapshot().project?.tracks[0].playbackVolume,
    ).toBe(42);
  });

  it("offers automatic instrument estimation alongside fixed presets", () => {
    renderScreen(
      {
        available: true,
        modelDirectory: "D:\\models\\bs-roformer\\sw-fixed",
        reason: "",
      },
      [registeredModel],
    );

    const automatic = screen.getByRole("option", { name: "自動推定" });
    expect(automatic).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: /楽器の決め方/ }), {
      target: { value: automatic.getAttribute("value") },
    });
    expect(screen.getByRole("button", { name: "編集" })).toBeDisabled();
  });

  it("deletes a selected user preset and selects the first remaining preset", async () => {
    const userPreset: PresetDefinition = {
      ...presets[0],
      id: "user-preset-id",
      key: "user:user-preset-id",
      name: "ユーザー設定",
    };
    const deletePreset = vi.fn().mockResolvedValue({ deleted: true });
    const onPresetsChange = vi.fn();
    function PresetDeletionHarness() {
      const [currentPresets, setCurrentPresets] = useState([
        presets[0],
        userPreset,
      ]);
      return (
        <NewProjectScreen
          client={{ deletePreset } as unknown as LocalApiClient}
          instruments={instruments}
          presets={currentPresets}
          models={models}
          backends={backends}
          stemSeparation={availableStemSeparation}
          onModelsChange={vi.fn()}
          onPresetsChange={(nextPresets) => {
            onPresetsChange(nextPresets);
            setCurrentPresets(nextPresets);
          }}
        />
      );
    }
    render(
      <PresetDeletionHarness />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: /楽器の決め方/ }), {
      target: { value: userPreset.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    const confirmation = screen.getByRole("dialog", {
      name: "プリセット削除の確認",
    });
    expect(confirmation).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "プリセットを削除" }),
    );

    await waitFor(() => expect(deletePreset).toHaveBeenCalledWith(userPreset.id));
    expect(onPresetsChange).toHaveBeenCalledWith([presets[0]]);
    expect(
      screen.queryByRole("dialog", { name: "プリセット削除の確認" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /楽器の決め方/ })).toHaveValue(
      presets[0].id,
    );
    expect(
      screen.getByRole("combobox", { name: /楽器の決め方/ }),
    ).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    expect(
      screen.getByRole("dialog", { name: "プリセット編集" }),
    ).toBeInTheDocument();
  });

  it("does not allow built-in presets to be deleted", () => {
    renderScreen({ available: true, modelDirectory: "", reason: "" });

    expect(screen.getByRole("button", { name: "削除" })).toBeDisabled();
  });

  it("replaces the selected user preset after overwrite", async () => {
    const userPreset: PresetDefinition = {
      ...presets[0],
      id: "user-preset-id",
      key: "user:user-preset-id",
      name: "ユーザー設定",
    };
    const overwrittenPreset: PresetDefinition = {
      ...userPreset,
      tracks: [
        {
          ...userPreset.tracks[0],
          displayName: "Keys",
          gmProgram: 0,
        },
      ],
    };
    const overwritePreset = vi.fn().mockResolvedValue(overwrittenPreset);
    const onPresetsChange = vi.fn();
    render(
      <NewProjectScreen
        client={{ overwritePreset } as unknown as LocalApiClient}
        instruments={instruments}
        presets={[userPreset]}
        models={models}
        backends={backends}
        stemSeparation={availableStemSeparation}
        onModelsChange={vi.fn()}
        onPresetsChange={onPresetsChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("トラック名"), {
      target: { value: "Keys" },
    });
    fireEvent.click(screen.getByRole("button", { name: "上書き保存" }));

    await waitFor(() =>
      expect(overwritePreset).toHaveBeenCalledWith(
        userPreset.id,
        userPreset.name,
        overwrittenPreset.tracks,
      ),
    );
    expect(onPresetsChange).toHaveBeenCalledWith([overwrittenPreset]);
    expect(
      screen.queryByRole("dialog", { name: "プリセット編集" }),
    ).not.toBeInTheDocument();
  });

  it("restores preset controls when deletion fails", async () => {
    const userPreset: PresetDefinition = {
      ...presets[0],
      id: "user-preset-id",
      key: "user:user-preset-id",
      name: "ユーザー設定",
    };
    const deletePreset = vi.fn().mockRejectedValue(new Error("削除失敗"));
    render(
      <NewProjectScreen
        client={{ deletePreset } as unknown as LocalApiClient}
        instruments={instruments}
        presets={[presets[0], userPreset]}
        models={models}
        backends={backends}
        stemSeparation={availableStemSeparation}
        onModelsChange={vi.fn()}
        onPresetsChange={vi.fn()}
      />,
    );

    const presetSelector = screen.getByRole("combobox", {
      name: /楽器の決め方/,
    });
    fireEvent.change(presetSelector, { target: { value: userPreset.id } });
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    fireEvent.click(
      screen.getByRole("button", { name: "プリセットを削除" }),
    );

    expect(await screen.findByText("削除失敗")).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "プリセット削除の確認" }),
    ).not.toBeInTheDocument();
    expect(presetSelector).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    expect(
      screen.getByRole("dialog", { name: "プリセット編集" }),
    ).toBeInTheDocument();
  });

  it("requires a registered model for automatic instrument estimation", () => {
    renderScreen({
      available: true,
      modelDirectory: "D:\\models\\bs-roformer\\sw-fixed",
      reason: "",
    });

    expect(screen.getByRole("option", { name: "自動推定" })).toBeDisabled();
  });

  it("uses the validated transcription method without an expert search setting", () => {
    renderScreen({
      available: true,
      modelDirectory: "D:\\models\\bs-roformer\\sw-fixed",
      reason: "",
    });

    expect(screen.queryByLabelText("候補探索")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "探索を広げる（低速）" }),
    ).not.toBeInTheDocument();
  });

  it("shows the license warning and download action when the model is missing", () => {
    const modelDirectory =
      "D:\\EarCopyAssist\\models\\bs-roformer\\sw-fixed";
    renderScreen({
      available: false,
      modelDirectory,
      reason: `BS-RoFormer SW Fixedモデルが見つかりません。配置先: ${modelDirectory}`,
    });

    expect(
      screen.getByRole("option", { name: "音源分離してから採譜" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        new RegExp(modelDirectory.replace(/\\/g, "\\\\")),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("ライセンス: Unknown")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "警告を確認してダウンロード" }),
    ).toBeEnabled();
  });

  it("downloads the acknowledged model and selects source-separated mode", async () => {
    const missing: StemSeparationCapability = {
      ...availableStemSeparation,
      available: false,
      reason: "BS-RoFormer SW Fixedモデルが見つかりません",
    };
    const downloadStemSeparationModel = vi
      .fn()
      .mockResolvedValue(availableStemSeparation);

    function DownloadScreen() {
      const [capability, setCapability] = useState(missing);
      return (
        <NewProjectScreen
          client={{ downloadStemSeparationModel } as unknown as LocalApiClient}
          instruments={instruments}
          presets={presets}
          models={models}
          backends={backends}
          stemSeparation={capability}
          onModelsChange={vi.fn()}
          onPresetsChange={vi.fn()}
          onStemSeparationChange={setCapability}
        />
      );
    }

    render(<DownloadScreen />);
    fireEvent.click(
      screen.getByRole("button", { name: "警告を確認してダウンロード" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "音源分離モデルをダウンロード",
    });
    const confirm = within(dialog).getByRole("checkbox", {
      name: "ライセンスがUnknownであり、利用許諾を確認できないことを理解しました",
    });
    const download = within(dialog).getByRole("button", {
      name: "警告を確認してダウンロード",
    });
    expect(download).toBeDisabled();
    fireEvent.click(confirm);
    fireEvent.click(download);

    await waitFor(() =>
      expect(downloadStemSeparationModel).toHaveBeenCalledWith(true),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("処理モード")).toHaveValue("separated"),
    );
    expect(
      screen.getByRole("option", { name: "音源分離してから採譜" }),
    ).toBeEnabled();
  });

  it("enables source-separated mode when the external model is present", () => {
    renderScreen({
      available: true,
      modelDirectory:
        "D:\\EarCopyAssist\\models\\bs-roformer\\sw-fixed",
      reason: "",
    });

    expect(
      screen.getByRole("option", { name: "音源分離してから採譜" }),
    ).toBeEnabled();

    fireEvent.change(screen.getByLabelText("処理モード"), {
      target: { value: "separated" },
    });
    const details = screen.getByText("音源分離後の採譜方法", {
      selector: "summary",
    });
    expect(details).toBeInTheDocument();
    expect(details.closest("details")).toHaveAttribute("open");
    expect(screen.queryByLabelText(/分離成分別採譜/)).not.toBeInTheDocument();
    expect(
      screen.getByLabelText(/音源分離後の発音開始時刻の誤差を低減する/),
    ).toBeChecked();
    expect(
      screen.getByText(
        "Bass、Piano、Guitar、Vocal、Otherの分離後音源へドラム成分を20%加えて採譜します",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/ピアノ取りこぼし補助/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/途中結果を表示/)).not.toBeInTheDocument();
  });
});
