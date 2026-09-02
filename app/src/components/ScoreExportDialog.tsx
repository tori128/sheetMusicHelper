import { useEffect, useRef, useState } from "react";
import { Localized } from "../i18n";
import { AlertCircle, AlertTriangle, FileMusic, RefreshCw, X } from "lucide-react";
import { estimateKeySignature } from "../score-key-estimation";
import {
  MUSICXML_PREVIEW_MEASURE_LIMIT,
  renderMusicXmlPreview,
} from "../musicxml-preview";
import type {
  ProjectDocument,
  QuantizeGrid,
  ScoreSettings,
  ScoreValidationIssue,
  ScoreValidationResult,
} from "../types";

interface ScoreExportDialogProps {
  project: ProjectDocument;
  validation: ScoreValidationResult | null;
  musicXml: string | null;
  loading: boolean;
  quantizeGrid: QuantizeGrid;
  onChange(update: Partial<ScoreSettings>): void;
  onQuantizeGridChange(grid: QuantizeGrid): void;
  onRefresh(): void;
  onSelectIssue(issue: ScoreValidationIssue): void;
  onExport(): void;
  onClose(): void;
}

const KEY_OPTIONS = [
  [-7, "Cb / Abm"],
  [-6, "Gb / Ebm"],
  [-5, "Db / Bbm"],
  [-4, "Ab / Fm"],
  [-3, "Eb / Cm"],
  [-2, "Bb / Gm"],
  [-1, "F / Dm"],
  [0, "C / Am"],
  [1, "G / Em"],
  [2, "D / Bm"],
  [3, "A / F#m"],
  [4, "E / C#m"],
  [5, "B / G#m"],
  [6, "F# / D#m"],
  [7, "C# / A#m"],
] as const;

const QUANTIZE_GRIDS: QuantizeGrid[] = [
  "1/4",
  "1/8",
  "1/16",
  "1/32",
  "1/8T",
  "1/16T",
];

export function ScoreExportDialog({
  project,
  validation,
  musicXml,
  loading,
  quantizeGrid,
  onChange,
  onQuantizeGridChange,
  onRefresh,
  onSelectIssue,
  onExport,
  onClose,
}: ScoreExportDialogProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const measureTicks =
    (project.tempo.ppq * project.tempo.timeSignature.numerator * 4) /
    project.tempo.timeSignature.denominator;
  const pickupOptions = ([
    [0, "なし"],
    [project.tempo.ppq / 4, "16分音符"],
    [project.tempo.ppq / 2, "8分音符"],
    [project.tempo.ppq, "4分音符"],
    [project.tempo.ppq * 2, "2分音符"],
  ] satisfies Array<[number, string]>).filter(([ticks]) => ticks < measureTicks);

  useEffect(() => {
    const container = previewRef.current;
    if (container === null || musicXml === null) {
      return;
    }
    container.replaceChildren();
    let cancelled = false;
    setPreviewError(null);
    void renderMusicXmlPreview(container, musicXml, () => cancelled)
      .catch((reason: unknown) => {
        if (!cancelled) {
          setPreviewError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [musicXml]);

  const errors = validation?.errorCount ?? 0;
  const warnings = validation?.warningCount ?? 0;
  const validationReady = validation !== null;
  const exportEnabled = validationReady && errors === 0 && !loading;
  const updateTrackSettings = (
    trackId: string,
    update: Partial<ScoreSettings["trackSettings"][string]>,
  ) => {
    const current = project.score.trackSettings[trackId] ?? {
      clef: "auto" as const,
      transpositionSemitones: 0,
    };
    onChange({
      trackSettings: {
        ...project.score.trackSettings,
        [trackId]: { ...current, ...update },
      },
    });
  };

  return (
    <Localized>
    <div className="modal-backdrop score-export-backdrop" role="presentation">
      <section
        className="score-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="score-export-title"
      >
        <header className="score-export-dialog__header">
          <div>
            <h2 id="score-export-title">MusicXML書き出し</h2>
            <span>音符を指定した分解能でクオンタイズして書き出します</span>
          </div>
          <button
            type="button"
            className="secondary-button icon-button"
            title="閉じる"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="score-export-dialog__body">
          <aside className="score-settings-panel">
            <h3>書き出し設定</h3>
            <label>
              <span>音符の分解能</span>
              <select
                aria-label="書き出す音符の分解能"
                value={quantizeGrid}
                onChange={(event) =>
                  onQuantizeGridChange(event.target.value as QuantizeGrid)
                }
              >
                {QUANTIZE_GRIDS.map((grid) => (
                  <option key={grid}>{grid}</option>
                ))}
              </select>
            </label>
            <p className="score-settings-panel__quantize-description">
              書き出す音符の開始位置と終了位置を指定した分解能に合わせます
            </p>

            <h3 className="score-settings-panel__section-heading">楽譜情報</h3>
            <label>
              <span>曲名</span>
              <input value={project.name} disabled />
            </label>
            <label>
              <span>作曲者</span>
              <input
                value={project.score.composer}
                onChange={(event) => onChange({ composer: event.target.value })}
              />
            </label>
            <label>
              <span>編曲者</span>
              <input
                value={project.score.arranger}
                onChange={(event) => onChange({ arranger: event.target.value })}
              />
            </label>
            <label>
              <span>著作権表示</span>
              <input
                value={project.score.copyright}
                onChange={(event) => onChange({ copyright: event.target.value })}
              />
            </label>
            <div className="score-settings-panel__row">
              <label>
                <span>調号</span>
                <select
                  value={project.score.keyFifths}
                  onChange={(event) => onChange({ keyFifths: Number(event.target.value) })}
                >
                  {KEY_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>長調・短調</span>
                <select
                  value={project.score.keyMode}
                  onChange={(event) => onChange({ keyMode: event.target.value as "major" | "minor" })}
                >
                  <option value="major">長調</option>
                  <option value="minor">短調</option>
                </select>
              </label>
            </div>
            <button
              type="button"
              className="score-settings-panel__estimate-key"
              onClick={() => {
                const estimated = estimateKeySignature(project.notes, project.tracks);
                if (estimated !== null) {
                  onChange({
                    keyFifths: estimated.keyFifths,
                    keyMode: estimated.keyMode,
                  });
                }
              }}
              disabled={project.notes.length === 0}
            >
              音符から調号候補を選択
            </button>
            <label>
              <span>弱起</span>
              <select
                value={project.score.pickupTicks}
                onChange={(event) => onChange({ pickupTicks: Number(event.target.value) })}
              >
                {pickupOptions.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="score-settings-panel__checkbox">
              <input
                type="checkbox"
                checked={project.score.includeChordSymbols}
                onChange={(event) => onChange({ includeChordSymbols: event.target.checked })}
              />
              <span>コード名をMusicXMLへ出力</span>
            </label>

            <div className="score-track-settings">
              <h3>パート別の記譜</h3>
              <p>移調は解析音高に加える半音数です。Bb管は+2を指定します。</p>
              <div className="score-track-settings__header" aria-hidden="true">
                <span>パート</span>
                <span>音部記号</span>
                <span>移調</span>
              </div>
              {project.tracks.map((track) => {
                const settings = project.score.trackSettings[track.id] ?? {
                  clef: "auto" as const,
                  transpositionSemitones: 0,
                };
                return (
                  <div className="score-track-settings__row" key={track.id}>
                    <span title={track.displayName}>{track.displayName}</span>
                    <select
                      aria-label={`${track.displayName}の音部記号`}
                      value={settings.clef}
                      onChange={(event) =>
                        updateTrackSettings(track.id, {
                          clef: event.target.value as typeof settings.clef,
                        })
                      }
                    >
                      <option value="auto">自動</option>
                      {track.kind === "drums" ? (
                        <option value="percussion">打楽器</option>
                      ) : (
                        <>
                          <option value="treble">ト音記号</option>
                          <option value="alto">アルト記号</option>
                          <option value="tenor">テノール記号</option>
                          <option value="bass">ヘ音記号</option>
                          <option value="grand">大譜表</option>
                        </>
                      )}
                    </select>
                    <input
                      type="number"
                      min="-24"
                      max="24"
                      step="1"
                      aria-label={`${track.displayName}の記譜音高移調`}
                      value={settings.transpositionSemitones}
                      disabled={track.kind === "drums"}
                      onChange={(event) =>
                        updateTrackSettings(track.id, {
                          transpositionSemitones: Math.max(
                            -24,
                            Math.min(24, Number(event.target.value)),
                          ),
                        })
                      }
                    />
                  </div>
                );
              })}
            </div>

            <div className="score-validation-summary">
              <div className={errors > 0 ? "is-error" : "is-clear"}>
                <AlertCircle size={16} aria-hidden="true" />
                <span>要修正 {validationReady ? errors : "-"}件</span>
              </div>
              <div className={warnings > 0 ? "is-warning" : "is-clear"}>
                <AlertTriangle size={16} aria-hidden="true" />
                <span>確認 {validationReady ? warnings : "-"}件</span>
              </div>
              <button type="button" onClick={onRefresh} disabled={loading}>
                <RefreshCw size={14} aria-hidden="true" />
                <span>{loading ? "検査中…" : "再検査"}</span>
              </button>
            </div>

            <div className="score-validation-list">
              {validation?.issues.length === 0 && (
                <p className="score-validation-list__empty">検出項目はありません</p>
              )}
              {validation?.issues.map((issue, index) => (
                <button
                  type="button"
                  key={`${issue.code}-${issue.timeSec}-${index}`}
                  className={`score-validation-issue is-${issue.severity}`}
                  onClick={() => onSelectIssue(issue)}
                >
                  {issue.severity === "error" ? (
                    <AlertCircle size={15} aria-hidden="true" />
                  ) : (
                    <AlertTriangle size={15} aria-hidden="true" />
                  )}
                  <span>
                    <strong>{issue.measureNumber}.{issue.beatNumber}</strong>
                    {issue.message}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <div className="score-preview-panel">
            <div className="score-preview-panel__heading">
              <h3>MusicXMLプレビュー</h3>
              <span>
                先頭{MUSICXML_PREVIEW_MEASURE_LIMIT}小節を表示しています。書き出しファイルには全小節が含まれます
              </span>
            </div>
            {previewError !== null && <p className="inline-error">{previewError}</p>}
            <div className="score-preview" ref={previewRef} />
          </div>
        </div>

        <footer className="score-export-dialog__actions">
          <span>
            {loading
              ? "書き出し前検査を実行しています"
              : !validationReady
                ? "検査結果を取得できません"
                : errors > 0
                  ? "要修正項目を選択して編集してください"
                  : "書き出し可能です"}
          </span>
          <button type="button" className="primary-button button-with-icon" onClick={onExport} disabled={!exportEnabled}>
            <FileMusic size={16} aria-hidden="true" />
            <span>MusicXML書き出し</span>
          </button>
        </footer>
      </section>
    </div>
    </Localized>
  );
}
