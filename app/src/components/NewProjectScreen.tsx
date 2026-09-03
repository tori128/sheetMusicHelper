import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ArrowRight,
  CircleHelp,
  FolderOpen,
  Music2,
  Settings as SettingsIcon,
} from "lucide-react";
import type { LocalApiClient } from "../api";
import {
  DEFAULT_SEPARATED_SETTINGS,
  projectStore,
  type NewProjectSourceSelection,
} from "../store/project-store";
import type {
  AudioInfo,
  BackendCapability,
  InferenceBackend,
  InstrumentDefinition,
  ModelProfile,
  PresetDefinition,
  StemSeparationCapability,
  TranscriptionProfile,
} from "../types";
import { BpmInput } from "./BpmInput";
import { PresetEditor } from "./PresetEditor";
import { AboutDialog } from "./AboutDialog";
import { SettingsDialog } from "./SettingsDialog";
import { SourceSeparationOptions } from "./SourceSeparationOptions";
import { StemModelDownloadDialog } from "./StemModelDownloadDialog";
import { readPostTranscriptionOptions } from "../transcription-option-settings";
import { Localized, useAppLanguage } from "../i18n";
import { LanguageSelect } from "./LanguageSelect";

interface NewProjectScreenProps {
  client: LocalApiClient;
  instruments: InstrumentDefinition[];
  presets: PresetDefinition[];
  models: ModelProfile[];
  backends: BackendCapability[];
  stemSeparation: StemSeparationCapability;
  initialSourceSelection?: NewProjectSourceSelection | null;
  onModelsChange(models: ModelProfile[]): void;
  onPresetsChange(presets: PresetDefinition[]): void;
  onStemSeparationChange?(capability: StemSeparationCapability): void;
}

const AUTOMATIC_PRESET_ID = "__automatic__";

function fileStem(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "new-project";
  return name.replace(/\.[^.]+$/, "");
}

function availableBackend(
  preferred: InferenceBackend,
  backends: BackendCapability[],
): InferenceBackend {
  if (
    backends.some(
      (backend) => backend.id === preferred && backend.available,
    )
  ) {
    return preferred;
  }
  return backends.find((backend) => backend.available)?.id ?? "CPU";
}

export function NewProjectScreen({
  client,
  instruments,
  presets,
  models,
  backends,
  stemSeparation,
  initialSourceSelection = null,
  onModelsChange,
  onPresetsChange,
  onStemSeparationChange,
}: NewProjectScreenProps) {
  const { locale, t } = useAppLanguage();
  const [audio, setAudio] = useState<AudioInfo | null>(
    initialSourceSelection?.audio ?? null,
  );
  const [name, setName] = useState(initialSourceSelection?.name ?? "");
  const [presetId, setPresetId] = useState(
    presets[0]?.id ?? AUTOMATIC_PRESET_ID,
  );
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [backend, setBackend] = useState<InferenceBackend>(
    availableBackend(models[0]?.defaultBackend ?? "Auto", backends),
  );
  const [bpm, setBpm] = useState(initialSourceSelection?.bpm ?? 120);
  const [beatOffsetSec, setBeatOffsetSec] = useState(
    initialSourceSelection?.beatOffsetSec ?? 0,
  );
  const [numerator, setNumerator] = useState(4);
  const [denominator, setDenominator] = useState<2 | 4 | 8 | 16>(4);
  const [mode, setMode] = useState<"direct" | "separated">("direct");
  const [transcriptionProfile, setTranscriptionProfile] =
    useState<TranscriptionProfile>("high_accuracy");
  const [separatedSettings, setSeparatedSettings] = useState(() =>
    readPostTranscriptionOptions(DEFAULT_SEPARATED_SETTINGS),
  );
  const [busy, setBusy] = useState(false);
  const [measurePositionAnalyzing, setMeasurePositionAnalyzing] =
    useState(false);
  const measurePositionRequestId = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editingPreset, setEditingPreset] = useState(false);
  const [presetPendingDeletion, setPresetPendingDeletion] =
    useState<PresetDefinition | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showStemModelDownload, setShowStemModelDownload] = useState(false);
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === presetId),
    [presetId, presets],
  );
  const automaticInstrumentSelection = presetId === AUTOMATIC_PRESET_ID;
  const selectedModel = useMemo(
    () => models.find((model) => model.id === modelId) ?? null,
    [modelId, models],
  );

  useEffect(() => {
    if (
      presetId !== AUTOMATIC_PRESET_ID &&
      !presets.some((preset) => preset.id === presetId)
    ) {
      setPresetId(presets[0]?.id ?? AUTOMATIC_PRESET_ID);
      setEditingPreset(false);
      setPresetPendingDeletion(null);
    }
  }, [presetId, presets]);

  async function selectAudio() {
    const path = await window.desktopApi.selectAudioFile();
    if (path === null) {
      return;
    }
    await loadAudioPath(path);
  }

  async function loadAudioPath(path: string) {
    measurePositionRequestId.current += 1;
    setMeasurePositionAnalyzing(false);
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const [info, tempo] = await Promise.all([
        client.inspectAudio(path),
        client.estimateTempo(path, numerator, denominator),
      ]);
      setAudio(info);
      setName(fileStem(path));
      setBpm(tempo.bpm);
      setBeatOffsetSec(tempo.beatOffsetSec);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function fitMeasurePosition(
    nextNumerator: number,
    nextDenominator: 2 | 4 | 8 | 16,
  ) {
    if (
      audio === null ||
      !Number.isInteger(nextNumerator) ||
      nextNumerator < 1 ||
      nextNumerator > 12
    ) {
      return;
    }
    const requestId = measurePositionRequestId.current + 1;
    measurePositionRequestId.current = requestId;
    setMeasurePositionAnalyzing(true);
    setError(null);
    try {
      const tempo = await client.estimateTempo(
        audio.absolutePath,
        nextNumerator,
        nextDenominator,
      );
      if (measurePositionRequestId.current === requestId) {
        setBeatOffsetSec(tempo.beatOffsetSec);
      }
    } catch (reason) {
      if (measurePositionRequestId.current === requestId) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (measurePositionRequestId.current === requestId) {
        setMeasurePositionAnalyzing(false);
      }
    }
  }

  async function dropAudio(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file === undefined) {
      return;
    }
    const path = window.desktopApi.getPathForDroppedFile(file);
    if (path) {
      await loadAudioPath(path);
    }
  }

  async function openProject() {
    const path = await window.desktopApi.selectProjectFile();
    if (path === null) {
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const project = await client.loadProject(path);
      const model =
        models.find(
          (candidate) =>
            candidate.id === project.transcription?.modelProfileId,
        ) ?? null;
      projectStore.openProject(project, model);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function applyModels(
    nextModels: ModelProfile[],
    preferredModelId: string | null = null,
  ) {
    onModelsChange(nextModels);
    const nextModel =
      nextModels.find((model) => model.id === preferredModelId) ??
      nextModels.find((model) => model.id === modelId) ??
      nextModels[0] ??
      null;
    setModelId(nextModel?.id ?? "");
    if (nextModel !== null) {
      setBackend(availableBackend(nextModel.defaultBackend, backends));
    }
  }

  async function reloadModels() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      applyModels(await client.models);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function addModel() {
    const path = await window.desktopApi.selectModelFile();
    if (path === null) {
      return;
    }
    const suggestedName = path.split(/[\\/]/).slice(-2, -1)[0] ?? fileStem(path);
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const profile = await client.registerModel(
        path,
        `MuScriptor ${suggestedName}`,
      );
      applyModels(await client.models, profile.id);
      setMessage(`登録完了: ${profile.variant}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function createProject() {
    if (
      audio === null ||
      (!automaticInstrumentSelection && selectedPreset === undefined) ||
      (automaticInstrumentSelection && selectedModel === null)
    ) {
      return;
    }
    try {
      projectStore.createProject({
        name,
        audio,
        bpm,
        beatOffsetSec,
        numerator,
        denominator,
        preset: selectedPreset,
        instruments,
        instrumentSelectionMode: automaticInstrumentSelection
          ? "automatic"
          : "fixed",
        model: selectedModel,
        mode,
        transcriptionProfile,
        separatedSettings,
        backend,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function savePresetAs(
    presetName: string,
    tracks: PresetDefinition["tracks"],
  ) {
    const saved = await client.savePreset(presetName, tracks);
    onPresetsChange([...presets, saved]);
    setPresetId(saved.id);
    setEditingPreset(false);
  }

  async function overwritePreset(
    presetId: string,
    presetName: string,
    tracks: PresetDefinition["tracks"],
  ) {
    const saved = await client.overwritePreset(presetId, presetName, tracks);
    onPresetsChange(
      presets.map((preset) => (preset.id === saved.id ? saved : preset)),
    );
    setPresetId(saved.id);
    setEditingPreset(false);
  }

  function requestPresetDeletion() {
    if (
      selectedPreset === undefined ||
      !selectedPreset.key.startsWith("user:")
    ) {
      return;
    }
    setPresetPendingDeletion(selectedPreset);
  }

  async function deletePendingPreset() {
    if (presetPendingDeletion === null) {
      return;
    }
    const deletingPreset = presetPendingDeletion;
    setBusy(true);
    setError(null);
    try {
      await client.deletePreset(deletingPreset.id);
      const remaining = presets.filter(
        (preset) => preset.id !== deletingPreset.id,
      );
      setPresetId(remaining[0]?.id ?? AUTOMATIC_PRESET_ID);
      setEditingPreset(false);
      setPresetPendingDeletion(null);
      onPresetsChange(remaining);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPresetPendingDeletion(null);
    } finally {
      setBusy(false);
    }
  }

  async function downloadStemModel() {
    const capability = await client.downloadStemSeparationModel(true);
    if (!capability.available) {
      throw new Error(capability.reason || "音源分離モデルを利用できません");
    }
    onStemSeparationChange?.(capability);
    setMode("separated");
    setMessage(
      `${capability.modelName}のダウンロードとSHA-256検証が完了しました。`,
    );
    setShowStemModelDownload(false);
  }

  return (
    <Localized>
    <main className="new-project-screen">
      <section className="welcome-panel">
        <h1>EarCopy Assist</h1>
        <div className="welcome-actions">
          <LanguageSelect />
          <button
            className="header-icon-button"
            type="button"
            aria-label="バージョン・ライセンス"
            title="バージョン・ライセンス"
            onClick={() => setShowAbout(true)}
          >
            <CircleHelp size={17} aria-hidden="true" />
          </button>
          <button
            className="header-icon-button"
            type="button"
            aria-label="設定"
            title="設定"
            onClick={() => setShowSettings(true)}
          >
            <SettingsIcon size={17} aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="project-card" aria-label="新規プロジェクト">
        <div className="card-heading">
          <h2>新規プロジェクト</h2>
          <button
            className="open-project-button"
            disabled={busy}
            onClick={() => void openProject()}
          >
            <FolderOpen size={14} aria-hidden="true" />
            .ecaprojを開く
          </button>
        </div>

        <button
          className={audio ? "audio-dropzone has-file" : "audio-dropzone"}
          onClick={selectAudio}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => void dropAudio(event)}
          disabled={busy}
        >
          <span className="dropzone-icon">
            <Music2 size={20} aria-hidden="true" />
          </span>
          {audio ? (
            <>
              <strong>{fileStem(audio.absolutePath)}</strong>
              <span>
                {audio.durationSec.toFixed(1)}秒 · {audio.sampleRate.toLocaleString(locale)} Hz ·{" "}
                {audio.channels} ch
              </span>
            </>
          ) : (
            <>
              <strong>{busy ? "音源を解析中…" : "音源ファイルを選択"}</strong>
              <span>WAV / MP3 / FLAC / OGG / M4A / AAC</span>
            </>
          )}
        </button>

        <label className="form-field">
          <span>プロジェクト名</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="音源を選択すると自動入力されます"
          />
        </label>

        <div className="form-grid">
          <div className="form-field">
            <span className="field-heading">
              <label htmlFor="instrument-selection">楽器の決め方</label>
              <span className="field-actions">
                <button
                  type="button"
                  className="inline-action"
                  disabled={
                    automaticInstrumentSelection || selectedPreset === undefined
                  }
                  onClick={() => setEditingPreset(true)}
                >
                  編集
                </button>
                <button
                  type="button"
                  className="inline-action inline-action--danger"
                  disabled={
                    busy ||
                    selectedPreset === undefined ||
                    !selectedPreset.key.startsWith("user:")
                  }
                  onClick={requestPresetDeletion}
                >
                  削除
                </button>
              </span>
            </span>
            <select
              id="instrument-selection"
              value={presetId}
              onChange={(event) => setPresetId(event.target.value)}
            >
              <option
                value={AUTOMATIC_PRESET_ID}
                disabled={models.length === 0}
              >
                自動推定
              </option>
              {presets.map((preset) => (
                <option
                  key={preset.id}
                  value={preset.id}
                  data-localize={
                    preset.key.startsWith("user:") ? "false" : undefined
                  }
                >
                  {preset.name}（{preset.trackCount}）
                </option>
              ))}
            </select>
          </div>
          <label className="form-field">
            <span className="field-heading">
              MuScriptorモデル
              <button
                type="button"
                className="inline-action"
                disabled={busy}
                onClick={() => void addModel()}
              >
                モデルを追加
              </button>
              <button
                type="button"
                className="inline-action"
                disabled={busy}
                onClick={() => void reloadModels()}
              >
                モデル一覧を更新
              </button>
            </span>
            <select
              value={modelId}
              onChange={(event) => {
                const nextId = event.target.value;
                setModelId(nextId);
                const nextModel = models.find((model) => model.id === nextId);
                if (nextModel) {
                  setBackend(
                    availableBackend(nextModel.defaultBackend, backends),
                  );
                }
              }}
              disabled={models.length === 0}
            >
              {models.length === 0 ? (
                <option value="">モデル未登録</option>
              ) : (
                models.map((model) => (
                  <option
                    key={model.id}
                    value={model.id}
                    data-localize="false"
                  >
                    {model.profileName} · {model.variant}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="form-field">
            <span>推論バックエンド</span>
            <select
              value={backend}
              onChange={(event) =>
                setBackend(event.target.value as InferenceBackend)
              }
            >
              {backends.map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                  disabled={!item.available}
                >
                  {item.id} · {item.reason}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="tempo-row">
          <label className="form-field">
            <span>BPM</span>
            <BpmInput
              value={bpm}
              onCommit={setBpm}
            />
          </label>
          <label className="form-field">
            <span>拍子</span>
            <div className="signature-input">
              <input
                type="number"
                aria-label="拍子の分子"
                min="1"
                max="12"
                value={numerator}
                onChange={(event) => setNumerator(Number(event.target.value))}
                onBlur={() => void fitMeasurePosition(numerator, denominator)}
                disabled={busy}
              />
              <span>/</span>
              <select
                aria-label="拍子の分母"
                value={denominator}
                onChange={(event) => {
                  const value = Number(event.target.value) as 2 | 4 | 8 | 16;
                  setDenominator(value);
                  void fitMeasurePosition(numerator, value);
                }}
                disabled={busy}
              >
                {[2, 4, 8, 16].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
          </label>
          <label className="form-field mode-field">
            <span>処理モード</span>
            <select
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as "direct" | "separated")
              }
            >
              <option value="direct">直接採譜</option>
              <option
                value="separated"
                disabled={!stemSeparation.available}
              >
                音源分離してから採譜
              </option>
            </select>
          </label>
          <label className="form-field mode-field">
            <span>採譜モード</span>
            <select
              value={transcriptionProfile}
              onChange={(event) =>
                setTranscriptionProfile(
                  event.target.value as TranscriptionProfile,
                )
              }
            >
              <option value="high_accuracy">高精度</option>
              <option value="fast">高速</option>
            </select>
          </label>
        </div>

        {mode === "separated" && (
          <SourceSeparationOptions
            settings={separatedSettings}
            onChange={setSeparatedSettings}
          />
        )}

        {!stemSeparation.available && (
          <section
            className="stem-model-download-notice"
            aria-label="音源分離モデルのダウンロード"
          >
            <div>
              <strong>音源分離モデルがありません</strong>
              <span>ライセンス: {stemSeparation.licenseStatus}</span>
            </div>
            <p>{stemSeparation.reason}</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setShowStemModelDownload(true)}
            >
              警告を確認してダウンロード
            </button>
          </section>
        )}
        {models.length === 0 && (
          <p className="notice">
            採譜にはMuScriptorモデルの登録が必要です。
          </p>
        )}
        {message && <p className="notice">{message}</p>}
        {error && <p className="error-message">{error}</p>}

        <button
          className="primary-button"
          disabled={
            audio === null ||
            (!automaticInstrumentSelection && selectedPreset === undefined) ||
            (automaticInstrumentSelection && selectedModel === null) ||
            measurePositionAnalyzing ||
            busy
          }
          onClick={createProject}
        >
          {selectedModel ? "採譜を開始" : "プロジェクトを作成"}
          <ArrowRight size={17} aria-hidden="true" />
        </button>
      </section>
      {editingPreset && selectedPreset !== undefined && (
        <PresetEditor
          instruments={instruments}
          preset={selectedPreset}
          onCancel={() => setEditingPreset(false)}
          onSaveAs={savePresetAs}
          onOverwrite={overwritePreset}
        />
      )}
      {presetPendingDeletion !== null && (
        <div className="modal-backdrop">
          <section
            className="preset-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="プリセット削除の確認"
          >
            <h2>プリセットを削除</h2>
            <p>{t(`「${presetPendingDeletion.name}」を削除します。`)}</p>
            <div className="preset-delete-dialog__actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                autoFocus
                onClick={() => setPresetPendingDeletion(null)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="secondary-button danger-button"
                disabled={busy}
                onClick={() => void deletePendingPreset()}
              >
                {busy ? "削除中…" : "プリセットを削除"}
              </button>
            </div>
          </section>
        </div>
      )}
      {showAbout && (
        <AboutDialog models={models} onClose={() => setShowAbout(false)} />
      )}
      {showSettings && (
        <SettingsDialog
          client={client}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showStemModelDownload && !stemSeparation.available && (
        <StemModelDownloadDialog
          capability={stemSeparation}
          onCancel={() => setShowStemModelDownload(false)}
          onDownload={downloadStemModel}
        />
      )}
    </main>
    </Localized>
  );
}
