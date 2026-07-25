import { useMemo, useState, type DragEvent } from "react";
import type { LocalApiClient } from "../api";
import { projectStore } from "../store/project-store";
import type {
  AudioInfo,
  BackendCapability,
  InferenceBackend,
  InstrumentDefinition,
  ModelProfile,
  PresetDefinition,
} from "../types";
import { BpmInput } from "./BpmInput";
import { PresetEditor } from "./PresetEditor";
import { AboutDialog } from "./AboutDialog";
import { SettingsDialog } from "./SettingsDialog";

interface NewProjectScreenProps {
  client: LocalApiClient;
  instruments: InstrumentDefinition[];
  presets: PresetDefinition[];
  models: ModelProfile[];
  backends: BackendCapability[];
  onModelsChange(models: ModelProfile[]): void;
  onPresetsChange(presets: PresetDefinition[]): void;
}

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
  onModelsChange,
  onPresetsChange,
}: NewProjectScreenProps) {
  const [audio, setAudio] = useState<AudioInfo | null>(null);
  const [name, setName] = useState("");
  const [presetId, setPresetId] = useState(presets[0]?.id ?? "");
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [backend, setBackend] = useState<InferenceBackend>(
    availableBackend(models[0]?.defaultBackend ?? "Auto", backends),
  );
  const [bpm, setBpm] = useState(120);
  const [beatOffsetSec, setBeatOffsetSec] = useState(0);
  const [numerator, setNumerator] = useState(4);
  const [denominator, setDenominator] = useState<2 | 4 | 8 | 16>(4);
  const [mode, setMode] = useState<"direct" | "four_stem">("direct");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editingPreset, setEditingPreset] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === presetId),
    [presetId, presets],
  );
  const selectedModel = useMemo(
    () => models.find((model) => model.id === modelId) ?? null,
    [modelId, models],
  );

  async function selectAudio() {
    const path = await window.desktopApi.selectAudioFile();
    if (path === null) {
      return;
    }
    await loadAudioPath(path);
  }

  async function loadAudioPath(path: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const [info, tempo] = await Promise.all([
        client.inspectAudio(path),
        client.estimateTempo(path),
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
      const tempo = await client.estimateTempo(
        project.sourceAudio.absolutePath,
      );
      const analyzedProject = {
        ...project,
        tempo: {
          ...project.tempo,
          bpm: tempo.bpm,
          beatOffsetSec: tempo.beatOffsetSec,
        },
      };
      const model =
        models.find(
          (candidate) =>
            candidate.id === analyzedProject.transcription?.modelProfileId,
        ) ?? null;
      projectStore.openProject(analyzedProject, model);
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
    const profileName = window.prompt(
      "モデルプロファイル名を入力してください",
      suggestedName,
    );
    if (profileName === null || !profileName.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const validation = await client.validateModel(path);
      if (!validation.loadable || validation.variant === null) {
        throw new Error(
          [...validation.errors, ...validation.warnings].join("; ") ||
            "モデルを読み込めません",
        );
      }
      const profile = await client.registerModel(path, profileName.trim());
      const next = [
        ...models.filter((candidate) => candidate.sha256 !== profile.sha256),
        profile,
      ];
      onModelsChange(next);
      setModelId(profile.id);
      setBackend(availableBackend(profile.defaultBackend, backends));
      const memoryGiB = validation.estimatedMemoryBytes / 1024 ** 3;
      setMessage(
        `登録完了: ${validation.variant} / 推定メモリ ${memoryGiB.toFixed(1)} GiB`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function createProject() {
    if (audio === null || selectedPreset === undefined) {
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
        model: selectedModel,
        mode,
        backend,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function savePreset(
    presetName: string,
    tracks: PresetDefinition["tracks"],
  ) {
    const saved = await client.savePreset(presetName, tracks);
    onPresetsChange([...presets, saved]);
    setPresetId(saved.id);
    setEditingPreset(false);
  }

  return (
    <main className="new-project-screen">
      <section className="welcome-panel">
        <h1>EarCopy Assist</h1>
        <button
          className="about-button"
          type="button"
          onClick={() => setShowAbout(true)}
        >
          バージョン・ライセンス
        </button>
        <button
          className="about-button"
          type="button"
          onClick={() => setShowSettings(true)}
        >
          設定
        </button>
      </section>

      <section className="project-card" aria-label="新規プロジェクト">
        <div className="card-heading">
          <button
            className="open-project-button"
            disabled={busy}
            onClick={() => void openProject()}
          >
            .ecaprojを開く
          </button>
          <h2>新規プロジェクト</h2>
        </div>

        <button
          className={audio ? "audio-dropzone has-file" : "audio-dropzone"}
          onClick={selectAudio}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => void dropAudio(event)}
          disabled={busy}
        >
          <span className="dropzone-icon">♪</span>
          {audio ? (
            <>
              <strong>{fileStem(audio.absolutePath)}</strong>
              <span>
                {audio.durationSec.toFixed(1)}秒 · {audio.sampleRate.toLocaleString()} Hz ·{" "}
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
          <label className="form-field">
            <span className="field-heading">
              編成プリセット
              <button
                type="button"
                className="inline-action"
                disabled={selectedPreset === undefined}
                onClick={() => setEditingPreset(true)}
              >
                編集
              </button>
            </span>
            <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}（{preset.trackCount}）
                </option>
              ))}
            </select>
          </label>
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
                  <option key={model.id} value={model.id}>
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
                min="1"
                max="12"
                value={numerator}
                onChange={(event) => setNumerator(Number(event.target.value))}
              />
              <span>/</span>
              <select
                value={denominator}
                onChange={(event) =>
                  setDenominator(Number(event.target.value) as 2 | 4 | 8 | 16)
                }
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
                setMode(event.target.value as "direct" | "four_stem")
              }
            >
              <option value="direct">直接採譜</option>
              <option value="four_stem">4ステム分離後に採譜</option>
            </select>
          </label>
        </div>

        {models.length === 0 && (
          <p className="notice">
            モデル未登録。モデルなしでは採譜を実行しません。
          </p>
        )}
        {message && <p className="notice">{message}</p>}
        {error && <p className="error-message">{error}</p>}

        <button
          className="primary-button"
          disabled={audio === null || selectedPreset === undefined || busy}
          onClick={createProject}
        >
          {selectedModel ? "採譜を開始" : "プロジェクトを作成"}
          <span>→</span>
        </button>
      </section>
      {editingPreset && selectedPreset !== undefined && (
        <PresetEditor
          instruments={instruments}
          preset={selectedPreset}
          onCancel={() => setEditingPreset(false)}
          onSave={savePreset}
        />
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
    </main>
  );
}
