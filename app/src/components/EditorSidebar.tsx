import { useState } from "react";
import { Localized } from "../i18n";
import type { ProjectStem, ProjectTrack, QuantizeGrid, StemType } from "../types";
import { MAX_BPM, MIN_BPM } from "./BpmInput";
import { OriginalAudioList } from "./OriginalAudioList";
import { TrackList } from "./TrackList";
import { StemList } from "./StemList";

interface EditorSidebarProps {
  tracks: ProjectTrack[];
  stems: ProjectStem[];
  trackControlsDisabled: boolean;
  stemControlsDisabled: boolean;
  originalAudioMuted: boolean;
  noteCount: number;
  selectedNoteCount: number;
  bpm: number;
  beatOffsetSec: number;
  quantizeGrid: QuantizeGrid;
  noteShiftMs: number;
  editingLocked: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onMute(trackId: string): void;
  onSolo(trackId: string): void;
  onStemMute(stemType: StemType): void;
  onStemSolo(stemType: StemType): void;
  onPlaybackOctaveShift(trackId: string, shift: 0 | 1): void;
  onPlaybackVolume(trackId: string, volume: number): void;
  onUndo(): void;
  onRedo(): void;
  onDeleteSelected(): void;
  canPaste: boolean;
  onCopySelected(): void;
  onPaste(): void;
  onSplitSelected(): void;
  onJoinSelected(): void;
  onSetSelectedDuration(): void;
  onScaleTempo(factor: 0.5 | 2): void;
  onSetMeasureStart(): void;
  onQuantizeGridChange(grid: QuantizeGrid): void;
  onQuantize(): void;
  onNoteShiftMsChange(value: number): void;
  onShiftMilliseconds(trackId: string | null): void;
  onShiftBeats(beats: number, trackId: string | null): void;
}

const QUANTIZE_GRIDS: QuantizeGrid[] = [
  "1/4",
  "1/8",
  "1/16",
  "1/32",
  "1/8T",
  "1/16T",
];

export function EditorSidebar({
  tracks,
  stems,
  trackControlsDisabled,
  stemControlsDisabled,
  originalAudioMuted,
  noteCount,
  selectedNoteCount,
  bpm,
  beatOffsetSec,
  quantizeGrid,
  noteShiftMs,
  editingLocked,
  canUndo,
  canRedo,
  onMute,
  onSolo,
  onStemMute,
  onStemSolo,
  onPlaybackOctaveShift,
  onPlaybackVolume,
  onUndo,
  onRedo,
  onDeleteSelected,
  canPaste,
  onCopySelected,
  onPaste,
  onSplitSelected,
  onJoinSelected,
  onSetSelectedDuration,
  onScaleTempo,
  onSetMeasureStart,
  onQuantizeGridChange,
  onQuantize,
  onNoteShiftMsChange,
  onShiftMilliseconds,
  onShiftBeats,
}: EditorSidebarProps) {
  const [activeTab, setActiveTab] = useState<"tracks" | "edit">("tracks");
  const [shiftTrackId, setShiftTrackId] = useState("all");
  const shiftTarget = shiftTrackId === "all" ? null : shiftTrackId;

  return (
    <Localized>
    <aside className="editor-sidebar">
      <div className="sidebar-tabs" role="tablist" aria-label="左パネル">
        <button
          id="tracks-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === "tracks"}
          aria-controls="tracks-panel"
          className={activeTab === "tracks" ? "is-selected" : ""}
          onClick={() => setActiveTab("tracks")}
        >
          トラック
        </button>
        <button
          id="edit-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === "edit"}
          aria-controls="edit-panel"
          className={activeTab === "edit" ? "is-selected" : ""}
          onClick={() => setActiveTab("edit")}
        >
          編集
        </button>
      </div>

      {activeTab === "tracks" ? (
        <div
          id="tracks-panel"
          className="sidebar-panel"
          role="tabpanel"
          aria-labelledby="tracks-tab"
        >
          <TrackList
            tracks={tracks}
            controlsDisabled={trackControlsDisabled}
            onMute={onMute}
            onSolo={onSolo}
            onPlaybackOctaveShift={onPlaybackOctaveShift}
            onPlaybackVolume={onPlaybackVolume}
          />
          {stems.length > 0 ? (
            <StemList
              stems={stems}
              controlsDisabled={stemControlsDisabled}
              onMute={onStemMute}
              onSolo={onStemSolo}
            />
          ) : (
            <OriginalAudioList muted={originalAudioMuted} />
          )}
        </div>
      ) : (
        <div
          id="edit-panel"
          className="sidebar-panel edit-panel"
          role="tabpanel"
          aria-labelledby="edit-tab"
        >
          {editingLocked && (
            <p className="editing-lock-message" role="status">
              採譜中はノートの追加、削除、パート移動を使用できます
            </p>
          )}
          <section className="edit-section">
            <h2>履歴とノート</h2>
            <div className="edit-history-grid">
              <button
                type="button"
                disabled={editingLocked || !canUndo}
                title="元に戻す (Ctrl+Z)"
                onClick={onUndo}
              >
                元に戻す
              </button>
              <button
                type="button"
                disabled={editingLocked || !canRedo}
                title="やり直す (Ctrl+Y)"
                onClick={onRedo}
              >
                やり直す
              </button>
            </div>
            <button
              type="button"
              className="sidebar-action"
              disabled={selectedNoteCount === 0}
              title="選択ノートを削除 (Delete)"
              onClick={onDeleteSelected}
            >
              選択ノートを削除
            </button>
            <div className="edit-history-grid">
              <button
                type="button"
                disabled={selectedNoteCount === 0}
                title="選択ノートをコピー (Ctrl+C)"
                onClick={onCopySelected}
              >
                コピー
              </button>
              <button
                type="button"
                disabled={!canPaste}
                title="再生位置へ貼り付け (Ctrl+V)"
                onClick={onPaste}
              >
                貼り付け
              </button>
            </div>
            <div className="edit-history-grid">
              <button
                type="button"
                disabled={editingLocked || selectedNoteCount === 0}
                title="再生位置で選択ノートを分割"
                onClick={onSplitSelected}
              >
                再生位置で分割
              </button>
              <button
                type="button"
                disabled={editingLocked || selectedNoteCount < 2}
                title="同じトラックと音高の隣接ノートを結合"
                onClick={onJoinSelected}
              >
                隣接ノートを結合
              </button>
            </div>
            <button
              type="button"
              className="sidebar-action"
              disabled={editingLocked || selectedNoteCount === 0}
              title="選択ノートの長さを現在のグリッド値へ変更"
              onClick={onSetSelectedDuration}
            >
              選択ノートの音価をグリッドに合わせる
            </button>
          </section>

          <section className="edit-section">
            <div className="edit-section__heading">
              <h2>テンポと小節</h2>
              <span>{Math.round(beatOffsetSec * 1000)} ms</span>
            </div>
            <div className="tempo-scale-grid" aria-label="テンポ倍率">
              <button
                type="button"
                disabled={editingLocked || bpm / 2 < MIN_BPM}
                aria-label="テンポを半分"
                onClick={() => onScaleTempo(0.5)}
              >
                半分
              </button>
              <button
                type="button"
                disabled={editingLocked || bpm * 2 > MAX_BPM}
                aria-label="テンポを2倍"
                onClick={() => onScaleTempo(2)}
              >
                2倍
              </button>
            </div>
            <button
              type="button"
              className="sidebar-action"
              aria-label="選択ノートを小節先頭に設定"
              disabled={editingLocked || selectedNoteCount !== 1}
              onClick={onSetMeasureStart}
            >
              小節先頭に設定
            </button>
          </section>

          <section className="edit-section">
            <h2>グリッド</h2>
            <label className="sidebar-field">
              <span>分解能</span>
              <select
                aria-label="クオンタイズグリッド"
                value={quantizeGrid}
                disabled={editingLocked}
                onChange={(event) =>
                  onQuantizeGridChange(event.target.value as QuantizeGrid)
                }
              >
                {QUANTIZE_GRIDS.map((grid) => (
                  <option key={grid}>{grid}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="sidebar-action"
              disabled={editingLocked || noteCount === 0}
              onClick={onQuantize}
            >
              拍位置にフィット
            </button>
          </section>

          <section className="edit-section">
            <h2>ノート位置移動</h2>
            <label className="sidebar-field">
              <span>対象</span>
              <select
                aria-label="位置移動の対象トラック"
                value={shiftTrackId}
                disabled={editingLocked}
                onChange={(event) => setShiftTrackId(event.target.value)}
              >
                <option value="all">全トラック</option>
                {tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.displayName}
                  </option>
                ))}
              </select>
            </label>
            <div className="beat-shift-grid" aria-label="拍単位で移動">
              <button
                type="button"
                disabled={editingLocked || noteCount === 0}
                aria-label="全ノートを1拍前へ"
                onClick={() => onShiftBeats(-1, shiftTarget)}
              >
                -1拍
              </button>
              <button
                type="button"
                disabled={editingLocked || noteCount === 0}
                aria-label="全ノートを半拍前へ"
                onClick={() => onShiftBeats(-0.5, shiftTarget)}
              >
                -1/2拍
              </button>
              <button
                type="button"
                disabled={editingLocked || noteCount === 0}
                aria-label="全ノートを半拍後へ"
                onClick={() => onShiftBeats(0.5, shiftTarget)}
              >
                +1/2拍
              </button>
              <button
                type="button"
                disabled={editingLocked || noteCount === 0}
                aria-label="全ノートを1拍後へ"
                onClick={() => onShiftBeats(1, shiftTarget)}
              >
                +1拍
              </button>
            </div>
            <label className="sidebar-field">
              <span>指定値</span>
              <div className="shift-value">
                <input
                  aria-label="ノート位置補正ミリ秒"
                  type="number"
                  min="-5000"
                  max="5000"
                  step="10"
                  value={noteShiftMs}
                  disabled={editingLocked}
                  onChange={(event) =>
                    onNoteShiftMsChange(Number(event.target.value))
                  }
                />
                <span>ms</span>
              </div>
            </label>
            <button
              type="button"
              className="sidebar-action"
              disabled={
                editingLocked || noteCount === 0 || noteShiftMs === 0
              }
              onClick={() => onShiftMilliseconds(shiftTarget)}
            >
              移動
            </button>
          </section>
        </div>
      )}
    </aside>
    </Localized>
  );
}
