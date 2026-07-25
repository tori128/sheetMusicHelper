import { useEffect, useMemo, useRef, useState } from "react";
import type { LocalApiClient } from "../api";
import { formatPlaybackTime } from "../playback";
import {
  normalizeAudioOutputDevices,
  normalizeMediaPlaybackRate,
  SoundFontPlaybackEngine,
  type AudioOutputDevice,
  type PlaybackSource,
} from "../soundfont-playback";
import {
  projectStore,
  type ProjectStoreState,
} from "../store/project-store";
import {
  cancelProjectTranscription,
  startProjectTranscription,
} from "../services/transcription-controller";
import type {
  ModelProfile,
  ProjectDocument,
  ProjectNote,
  QuantizeGrid,
} from "../types";
import { PianoRollCanvas } from "./PianoRollCanvas";
import { PlaybackSourceSwitch } from "./PlaybackSourceSwitch";
import { BpmInput } from "./BpmInput";
import {
  visibleNotesForRoll,
  visibleTracksForSolo,
} from "./piano-roll-visibility";
import { TrackList } from "./TrackList";

interface EditorScreenProps {
  client: LocalApiClient;
  project: ProjectDocument;
  model: ModelProfile | null;
  job: ProjectStoreState["job"];
  selectedNoteIds: ReadonlySet<string>;
}

const JOB_LABELS: Record<
  NonNullable<ProjectStoreState["job"]>["status"],
  string
> = {
  waiting: "開始待ち",
  preparing_audio: "音源を準備中",
  separating: "4ステムへ分離中",
  loading_model: "モデルを読み込み中",
  transcribing: "採譜中",
  building_project: "プロジェクトを構築中",
  completed: "採譜完了",
  failed: "採譜失敗",
  cancelled: "キャンセル済み",
};

export function EditorScreen({
  client,
  project,
  model,
  job,
  selectedNoteIds,
}: EditorScreenProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const playbackEngineRef = useRef<SoundFontPlaybackEngine | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState<
    "midi" | "musicxml" | "stems" | null
  >(null);
  const [exportedFile, setExportedFile] = useState<{
    kind: "MIDI" | "MusicXML" | "分離WAV";
    path: string;
  } | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackSource, setPlaybackSource] =
    useState<PlaybackSource>("original");
  const [soundFontBytes, setSoundFontBytes] = useState<Uint8Array | null>(null);
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([]);
  const [outputDeviceId, setOutputDeviceId] = useState("default");
  const [moveTargetId, setMoveTargetId] = useState(project.tracks[0]?.id ?? "");
  const [quantizeGrid, setQuantizeGrid] = useState<QuantizeGrid>(
    project.tempo.quantizeGrid,
  );
  const [tempoAnalyzing, setTempoAnalyzing] = useState(false);
  const [noteShiftMs, setNoteShiftMs] = useState(0);
  const [assignmentMenu, setAssignmentMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const visibleRollTracks = useMemo(
    () => visibleTracksForSolo(project.tracks),
    [project.tracks],
  );
  const visibleRollNotes = useMemo(
    () =>
      visibleNotesForRoll(
        project.notes,
        project.tracks,
        project.viewState.activeRoll,
      ),
    [project.notes, project.tracks, project.viewState.activeRoll],
  );

  useEffect(() => {
    void startProjectTranscription(client, projectStore);
  }, [client, project.projectId]);

  useEffect(() => {
    let active = true;
    setIsPlaying(false);
    setPlayheadSec(0);
    setAudioUrl(null);
    setPlaybackError(null);
    void window.desktopApi
      .getLocalAudioUrl(project.sourceAudio.absolutePath)
      .then((url) => {
        if (active) {
          setAudioUrl(url);
        }
      })
      .catch((reason) => {
        if (active) {
          setPlaybackError(
            reason instanceof Error ? reason.message : String(reason),
          );
        }
      });
    return () => {
      active = false;
      audioRef.current?.pause();
      const engine = playbackEngineRef.current;
      playbackEngineRef.current = null;
      if (engine !== null) {
        void engine.destroy();
      }
    };
  }, [project.projectId, project.sourceAudio.absolutePath]);

  useEffect(() => {
    let active = true;
    void window.desktopApi
      .loadSoundFont()
      .then((bytes) => {
        if (active) {
          setSoundFontBytes(bytes);
        }
      })
      .catch((reason) => {
        if (active) {
          setPlaybackError(
            reason instanceof Error ? reason.message : String(reason),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [project.projectId]);

  useEffect(() => {
    let active = true;
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((devices) => {
        if (active) {
          const normalized = normalizeAudioOutputDevices(devices);
          setOutputDevices(normalized);
          setOutputDeviceId((current) =>
            normalized.some((device) => device.deviceId === current)
              ? current
              : normalized[0]?.deviceId ?? "default",
          );
        }
      })
      .catch((reason) => {
        if (active) {
          setPlaybackError(
            reason instanceof Error ? reason.message : String(reason),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [project.projectId]);

  useEffect(() => {
    playbackEngineRef.current?.setProject(project.tracks, project.notes);
  }, [project.notes, project.tracks]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    let frame = 0;
    const updateCursor = () => {
      if (audioRef.current !== null) {
        setPlayheadSec(audioRef.current.currentTime);
      }
      frame = requestAnimationFrame(updateCursor);
    };
    frame = requestAnimationFrame(updateCursor);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  async function playAudio() {
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    setPlaybackError(null);
    try {
      normalizeMediaPlaybackRate(audio);
      const engine =
        playbackSource === "transcription"
          ? await ensurePlaybackEngine()
          : playbackEngineRef.current;
      await audio.play();
      await engine?.start();
    } catch (reason) {
      setPlaybackError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function ensurePlaybackEngine(): Promise<SoundFontPlaybackEngine> {
    if (playbackEngineRef.current !== null) {
      return playbackEngineRef.current;
    }
    if (audioRef.current === null || soundFontBytes === null) {
      throw new Error("SoundFontを読み込み中です");
    }
    const engine = await SoundFontPlaybackEngine.create(
      audioRef.current,
      soundFontBytes,
    );
    engine.setProject(project.tracks, project.notes);
    engine.setSource(playbackSource);
    await engine.setOutputDevice(outputDeviceId);
    playbackEngineRef.current = engine;
    return engine;
  }

  async function previewNote(note: ProjectNote) {
    const track = project.tracks.find(
      (candidate) => candidate.id === note.trackId,
    );
    if (track === undefined) {
      return;
    }
    setPlaybackError(null);
    try {
      const engine = await ensurePlaybackEngine();
      await engine.previewNote(track, note);
    } catch (reason) {
      setPlaybackError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function selectPlaybackSource(source: PlaybackSource) {
    setPlaybackError(null);
    try {
      const engine =
        source === "transcription"
          ? await ensurePlaybackEngine()
          : playbackEngineRef.current;
      engine?.setSource(source);
      setPlaybackSource(source);
      if (isPlaying) {
        await engine?.start();
      }
    } catch (reason) {
      setPlaybackError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function selectOutputDevice(deviceId: string) {
    setPlaybackError(null);
    try {
      const engine = await ensurePlaybackEngine();
      await engine.setOutputDevice(deviceId);
      setOutputDeviceId(deviceId);
      if (isPlaying) {
        await engine.start();
      }
    } catch (reason) {
      setPlaybackError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function analyzeTempo() {
    setTempoAnalyzing(true);
    setPlaybackError(null);
    try {
      const tempo = await client.estimateTempo(
        project.sourceAudio.absolutePath,
      );
      projectStore.setTempoAnalysis(tempo.bpm, tempo.beatOffsetSec);
    } catch (reason) {
      setPlaybackError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTempoAnalyzing(false);
    }
  }

  function shiftAllNotes() {
    projectStore.shiftAllNotes(noteShiftMs / 1000);
    setNoteShiftMs(0);
  }

  function stopAudio() {
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    audio.pause();
    playbackEngineRef.current?.pause();
    audio.currentTime = 0;
    setPlayheadSec(0);
    setIsPlaying(false);
  }

  function seekAudio(timeSec: number) {
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    const normalized = Math.min(
      project.sourceAudio.durationSec,
      Math.max(0, timeSec),
    );
    audio.currentTime = normalized;
    playbackEngineRef.current?.seek(normalized);
    setPlayheadSec(normalized);
  }

  async function closeProject() {
    try {
      await cancelProjectTranscription(client, projectStore);
    } finally {
      projectStore.closeProject();
    }
  }

  async function saveProject() {
    setSaving(true);
    setSaveError(null);
    try {
      const path = await window.desktopApi.saveProjectFile(
        `${project.name}.ecaproj`,
        JSON.stringify(project, null, 2),
      );
      if (path !== null) {
        setSavedPath(path);
      }
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function exportMidi() {
    const outputPath = await window.desktopApi.selectExportPath("midi");
    if (outputPath === null) {
      return;
    }
    setExporting("midi");
    setSaveError(null);
    try {
      setExportedFile({
        kind: "MIDI",
        path: await client.exportMidi(project, outputPath),
      });
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(null);
    }
  }

  async function exportMusicXml() {
    const outputPath = await window.desktopApi.selectExportPath("musicxml");
    if (outputPath === null) {
      return;
    }
    setExporting("musicxml");
    setSaveError(null);
    try {
      setExportedFile({
        kind: "MusicXML",
        path: await client.exportMusicXml(project, outputPath),
      });
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(null);
    }
  }

  async function exportStemFiles() {
    const outputDirectory = await window.desktopApi.selectExportDirectory();
    if (outputDirectory === null) {
      return;
    }
    setExporting("stems");
    setSaveError(null);
    try {
      const paths = await client.exportStems(project, outputDirectory);
      setExportedFile({ kind: "分離WAV", path: outputDirectory });
      if (paths.length > 0) {
        await window.desktopApi.showItemInFolder(paths[0]);
      }
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(null);
    }
  }

  const progress =
    job !== null && job.total > 0
      ? Math.min(100, Math.round((job.completed / job.total) * 100))
      : null;

  return (
    <main className="editor-screen">
      <header className="topbar">
        <button className="brand-button" onClick={() => void closeProject()}>
          <span className="brand-mark">E</span>
          <span>EarCopy Assist</span>
        </button>
        <div className="project-title">
          <strong>{project.name}</strong>
          <span>{savedPath === null ? "未保存" : `保存済み: ${savedPath}`}</span>
        </div>
        <button
          className="secondary-button"
          disabled={saving}
          onClick={() => void saveProject()}
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button
          className="secondary-button"
          disabled={exporting !== null}
          onClick={() => void exportMidi()}
        >
          {exporting === "midi" ? "書き出し中…" : "MIDI書き出し"}
        </button>
        <button
          className="secondary-button"
          disabled={exporting !== null}
          onClick={() => void exportMusicXml()}
        >
          {exporting === "musicxml"
            ? "書き出し中…"
            : "MusicXML書き出し"}
        </button>
        {project.stems.length === 4 && (
          <button
            className="secondary-button"
            disabled={exporting !== null}
            onClick={() => void exportStemFiles()}
          >
            {exporting === "stems"
              ? "書き出し中…"
              : "分離WAVを保存"}
          </button>
        )}
      </header>

      <section className="transport-bar" aria-label="再生コントロール">
        <audio
          ref={audioRef}
          src={audioUrl ?? undefined}
          preload="metadata"
          onPlay={() => setIsPlaying(true)}
          onPause={() => {
            setIsPlaying(false);
            playbackEngineRef.current?.pause();
          }}
          onEnded={() => {
            setIsPlaying(false);
            playbackEngineRef.current?.pause();
          }}
          onTimeUpdate={(event) =>
            setPlayheadSec(event.currentTarget.currentTime)
          }
          onError={() => setPlaybackError("音源を再生できません")}
        />
        <button
          className="transport-button"
          aria-label={isPlaying ? "一時停止" : "再生"}
          disabled={audioUrl === null}
          onClick={() => {
            if (isPlaying) {
              audioRef.current?.pause();
              playbackEngineRef.current?.pause();
            } else {
              void playAudio();
            }
          }}
        >
          {isPlaying ? "Ⅱ" : "▶"}
        </button>
        <button
          className="transport-button"
          aria-label="停止"
          disabled={audioUrl === null}
          onClick={stopAudio}
        >
          ■
        </button>
        <span className="time-display">{formatPlaybackTime(playheadSec)}</span>
        <input
          className="transport-seek"
          aria-label="再生位置"
          type="range"
          min="0"
          max={Math.max(project.sourceAudio.durationSec, 0.01)}
          step="0.01"
          value={playheadSec}
          onChange={(event) => seekAudio(Number(event.target.value))}
        />
        <PlaybackSourceSwitch
          value={playbackSource}
          transcriptionDisabled={soundFontBytes === null}
          onChange={(source) => void selectPlaybackSource(source)}
        />
        {outputDevices.length > 0 && (
          <label className="compact-field">
            出力
            <select
              aria-label="オーディオ出力デバイス"
              value={outputDeviceId}
              disabled={soundFontBytes === null}
              onChange={(event) =>
                void selectOutputDevice(event.target.value)
              }
            >
              {outputDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="compact-field">
          BPM
          <BpmInput
            value={project.tempo.bpm}
            onCommit={(value) => projectStore.setBpm(value)}
          />
        </label>
        <span className="signature-display">
          {project.tempo.timeSignature.numerator}/
          {project.tempo.timeSignature.denominator}
        </span>
        <div className="job-status" aria-live="polite">
          <span>{job === null ? "採譜モデルなし" : JOB_LABELS[job.status]}</span>
          {progress !== null && (
            <progress aria-label="採譜進捗" max="100" value={progress} />
          )}
          {job !== null &&
            !["completed", "failed", "cancelled"].includes(job.status) && (
              <button
                className="secondary-button"
                onClick={() =>
                  void cancelProjectTranscription(client, projectStore)
                }
              >
                キャンセル
              </button>
            )}
        </div>
      </section>

      <section className="timing-bar" aria-label="タイミング補正">
        <button
          className="secondary-button"
          disabled={tempoAnalyzing}
          onClick={() => void analyzeTempo()}
        >
          {tempoAnalyzing ? "解析中…" : "テンポ再解析"}
        </button>
        <span className="signature-display">
          拍位置 {Math.round((project.tempo.beatOffsetSec ?? 0) * 1000)} ms
        </span>
        <button
          className="secondary-button"
          aria-label="選択ノートを小節先頭に設定"
          disabled={selectedNoteIds.size !== 1}
          onClick={() => projectStore.setSelectedNoteAsMeasureStart()}
        >
          小節先頭に設定
        </button>
        <label className="compact-field">
          グリッド
          <select
            value={quantizeGrid}
            onChange={(event) =>
              setQuantizeGrid(event.target.value as QuantizeGrid)
            }
          >
            {["1/4", "1/8", "1/16", "1/32", "1/8T", "1/16T"].map(
              (grid) => (
                <option key={grid}>{grid}</option>
              ),
            )}
          </select>
        </label>
        <button
          className="secondary-button"
          onClick={() => projectStore.quantizeAll(quantizeGrid)}
        >
          拍位置にフィット
        </button>
        <label className="compact-field">
          全ノート位置（＋後／－前）
          <input
            aria-label="ノート位置補正ミリ秒"
            type="number"
            min="-5000"
            max="5000"
            step="10"
            value={noteShiftMs}
            onChange={(event) => setNoteShiftMs(Number(event.target.value))}
          />
          ms
        </label>
        <button
          className="secondary-button"
          disabled={project.notes.length === 0 || noteShiftMs === 0}
          onClick={shiftAllNotes}
        >
          移動
        </button>
      </section>

      <section className="workspace">
        <TrackList
          tracks={project.tracks}
          onMute={(id) => projectStore.toggleMute(id)}
          onSolo={(id) => projectStore.toggleSolo(id)}
        />
        <div className="roll-panel">
          <div className="roll-tabs">
            <button
              className={
                project.viewState.activeRoll === "pitched" ? "is-selected" : ""
              }
              onClick={() => projectStore.setActiveRoll("pitched")}
            >
              音程パート
            </button>
            <button
              className={
                project.viewState.activeRoll === "drums" ? "is-selected" : ""
              }
              onClick={() => projectStore.setActiveRoll("drums")}
            >
              ドラム
            </button>
            <div className="roll-tools">
              <select
                aria-label="移動先パート"
                value={moveTargetId}
                onChange={(event) => setMoveTargetId(event.target.value)}
                disabled={selectedNoteIds.size === 0}
              >
                {project.tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.displayName}
                  </option>
                ))}
              </select>
              <button
                disabled={selectedNoteIds.size === 0 || !moveTargetId}
                onClick={() => projectStore.moveSelectedNotes(moveTargetId)}
              >
                選択ノートを移動
              </button>
            </div>
          </div>
          <div className="roll-surface">
            <PianoRollCanvas
              key={project.projectId}
              notes={visibleRollNotes}
              tracks={visibleRollTracks}
              durationSec={project.sourceAudio.durationSec}
              horizontalZoom={project.viewState.horizontalZoom}
              verticalZoom={project.viewState.verticalZoom}
              bpm={project.tempo.bpm}
              beatOffsetSec={project.tempo.beatOffsetSec ?? 0}
              timeSignature={project.tempo.timeSignature}
              mode={project.viewState.activeRoll}
              selectedNoteIds={selectedNoteIds}
              initialScrollTimeSec={project.viewState.scrollTimeSec}
              playheadSec={playheadSec}
              followPlayhead={isPlaying}
              onSelectionChange={(noteIds) =>
                projectStore.setSelection(noteIds)
              }
              onNotePreview={(note) => void previewNote(note)}
              onScrollTimeChange={(timeSec) =>
                projectStore.setScrollTime(timeSec)
              }
              onZoomChange={(horizontalZoom, verticalZoom) =>
                projectStore.setZoom(horizontalZoom, verticalZoom)
              }
              onNoteContextMenu={(_noteId, point) =>
                setAssignmentMenu({ x: point.x, y: point.y })
              }
            />
            {assignmentMenu !== null && (
              <div
                className="assignment-menu"
                style={{ left: assignmentMenu.x, top: assignmentMenu.y }}
                role="menu"
              >
                <strong>パートへ移動</strong>
                {project.tracks
                  .filter((track) => track.kind === "pitched")
                  .map((track) => (
                    <button
                      key={track.id}
                      role="menuitem"
                      onClick={() => {
                        projectStore.moveSelectedNotes(track.id);
                        setAssignmentMenu(null);
                      }}
                    >
                      <span style={{ background: track.color }} />
                      {track.displayName}
                    </button>
                  ))}
              </div>
            )}
            {project.notes.length === 0 && (
              <div className="empty-roll-message">
                <strong>
                  {model === null
                    ? "採譜モデルが選択されていません"
                    : job?.status === "completed"
                      ? "ノートは検出されませんでした"
                      : "採譜結果を待っています"}
                </strong>
                <span>
                  {model === null
                    ? "新規プロジェクト画面でローカルモデルを選択してください。"
                    : `${model.profileName} をローカルで実行しています。`}
                </span>
              </div>
            )}
            {(job?.error ?? saveError ?? playbackError) !== null && (
              <div className="roll-error">
                {job?.error ?? saveError ?? playbackError}
              </div>
            )}
          </div>
          <footer className="statusbar">
            <span>ノート {project.notes.length}</span>
            <span>選択 {selectedNoteIds.size}</span>
            <span>PPQ {project.tempo.ppq}</span>
            <span>音源 {project.sourceAudio.durationSec.toFixed(1)} 秒</span>
            {exportedFile !== null && (
              <span>
                {exportedFile.kind}: {exportedFile.path}
              </span>
            )}
          </footer>
        </div>
      </section>
    </main>
  );
}
