import { useState } from "react";
import { Localized } from "../i18n";
import type {
  InstrumentDefinition,
  PresetDefinition,
  PresetTrackDefinition,
} from "../types";
import {
  ensureUniqueTrackColors,
  isPaletteColor,
  nextTrackColor,
  TRACK_COLOR_PALETTE,
} from "../track-colors";

interface PresetEditorProps {
  instruments: InstrumentDefinition[];
  preset: PresetDefinition;
  onCancel(): void;
  onSaveAs(name: string, tracks: PresetTrackDefinition[]): Promise<void>;
  onOverwrite(
    presetId: string,
    name: string,
    tracks: PresetTrackDefinition[],
  ): Promise<void>;
}

type EditablePresetTrack = PresetTrackDefinition & {
  colorMode: "palette" | "custom";
};

export function PresetEditor({
  instruments,
  preset,
  onCancel,
  onSaveAs,
  onOverwrite,
}: PresetEditorProps) {
  const canOverwrite = preset.key.startsWith("user:");
  const [name, setName] = useState(
    canOverwrite ? preset.name : `${preset.name} コピー`,
  );
  const [tracks, setTracks] = useState<EditablePresetTrack[]>(() =>
    ensureUniqueTrackColors(preset.tracks).map((track) => {
      const instrument = instruments.find(
        (candidate) => candidate.id === track.instrumentId,
      );
      const selectedProgram =
        instrument?.gmPrograms.some(
          (option) => option.program === track.gmProgram,
        ) === true
          ? track.gmProgram
          : instrument?.gmProgram;
      return {
        ...track,
        gmProgram: instrument?.kind === "drums" ? null : selectedProgram,
        colorMode: isPaletteColor(track.color) ? "palette" : "custom",
      };
    }),
  );
  const [savingAction, setSavingAction] = useState<
    "overwrite" | "save-as" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  function replaceTrack(
    index: number,
    update: Partial<EditablePresetTrack>,
  ) {
    setTracks((current) =>
      current.map((track, trackIndex) =>
        trackIndex === index ? { ...track, ...update } : track,
      ),
    );
  }

  function move(index: number, offset: -1 | 1) {
    const destination = index + offset;
    if (destination < 0 || destination >= tracks.length) {
      return;
    }
    setTracks((current) => {
      const next = [...current];
      [next[index], next[destination]] = [
        next[destination],
        next[index],
      ];
      return next.map((track, trackIndex) => ({
        ...track,
        order: trackIndex + 1,
      }));
    });
  }

  function addTrack() {
    if (tracks.length >= 16) {
      return;
    }
    const used = new Set(tracks.map((track) => track.instrumentId));
    const instrument = instruments.find((item) => !used.has(item.id));
    if (instrument === undefined) {
      setError("追加できる楽器グループがありません");
      return;
    }
    setTracks((current) => [
      ...current,
      {
        displayName: instrument.displayNameJa,
        instrumentId: instrument.id,
        color: nextTrackColor(current.map((track) => track.color)),
        kind: instrument.kind,
        order: current.length + 1,
        gmProgram: instrument.gmProgram,
        colorMode: "palette",
      },
    ]);
  }

  async function save(action: "overwrite" | "save-as") {
    if (!name.trim() || tracks.length === 0) {
      setError("プリセット名と1件以上のトラックが必要です");
      return;
    }
    const savedTracks = tracks.map(
      ({ colorMode: _colorMode, ...track }, index) => ({
        ...track,
        order: index + 1,
      }),
    );
    setSavingAction(action);
    setError(null);
    try {
      if (action === "overwrite") {
        await onOverwrite(preset.id, name.trim(), savedTracks);
      } else {
        await onSaveAs(name.trim(), savedTracks);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingAction(null);
    }
  }

  return (
    <Localized>
    <div className="modal-backdrop">
      <section
        className="preset-editor"
        role="dialog"
        aria-modal="true"
        aria-label="プリセット編集"
      >
        <header className="preset-editor-header">
          <h2>プリセット編集</h2>
          <button className="secondary-button" onClick={onCancel}>
            閉じる
          </button>
        </header>
        <label className="form-field">
          <span>プリセット名</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="preset-track-list">
          {tracks.map((track, index) => {
            const instrument = instruments.find(
              (candidate) => candidate.id === track.instrumentId,
            );
            const usedColors = new Set(
              tracks
                .filter((_candidate, candidateIndex) => candidateIndex !== index)
                .map((candidate) => candidate.color.toUpperCase()),
            );
            return (
              <div className="preset-track-row" key={index}>
                <span>{index + 1}</span>
                <button
                  className="preset-track-move"
                  aria-label="上へ"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  className="preset-track-move"
                  aria-label="下へ"
                  disabled={index === tracks.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <input
                  aria-label="トラック名"
                  value={track.displayName}
                  onChange={(event) =>
                    replaceTrack(index, { displayName: event.target.value })
                  }
                />
                <select
                  aria-label="楽器グループ"
                  value={track.instrumentId}
                  onChange={(event) => {
                    const instrument = instruments.find(
                      (item) => item.id === event.target.value,
                    );
                    if (instrument !== undefined) {
                      replaceTrack(index, {
                        instrumentId: instrument.id,
                        kind: instrument.kind,
                        gmProgram: instrument.gmProgram,
                      });
                    }
                  }}
                >
                  {instruments.map((instrument) => (
                    <option
                      key={instrument.id}
                      value={instrument.id}
                      disabled={tracks.some(
                        (candidate, candidateIndex) =>
                          candidateIndex !== index &&
                          candidate.instrumentId === instrument.id,
                      )}
                    >
                      {instrument.displayNameJa}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="再生音色"
                  value={track.gmProgram ?? ""}
                  disabled={
                    instrument?.kind === "drums" ||
                    instrument?.gmPrograms.length === 1
                  }
                  onChange={(event) =>
                    replaceTrack(index, {
                      gmProgram: Number(event.target.value),
                    })
                  }
                >
                  {instrument?.kind === "drums" ? (
                    <option value="">GMドラム</option>
                  ) : (
                    instrument?.gmPrograms.map((option) => (
                      <option key={option.program} value={option.program}>
                        {String(option.program + 1).padStart(3, "0")}{" "}
                        {option.displayNameJa}
                      </option>
                    ))
                  )}
                </select>
                <div className="preset-track-color">
                  <select
                    aria-label="トラック色"
                    value={
                      track.colorMode === "custom" ? "custom" : track.color
                    }
                    onChange={(event) => {
                      if (event.target.value === "custom") {
                        replaceTrack(index, { colorMode: "custom" });
                      } else {
                        replaceTrack(index, {
                          color: event.target.value,
                          colorMode: "palette",
                        });
                      }
                    }}
                  >
                    {TRACK_COLOR_PALETTE.map((color, colorIndex) => (
                      <option
                        key={color}
                        value={color}
                        disabled={usedColors.has(color)}
                      >
                        自動 {colorIndex + 1}
                      </option>
                    ))}
                    <option value="custom">カスタム</option>
                  </select>
                  {track.colorMode === "custom" ? (
                    <input
                      aria-label="カスタム色"
                      type="color"
                      value={track.color}
                      onChange={(event) =>
                        replaceTrack(index, { color: event.target.value })
                      }
                    />
                  ) : (
                    <span
                      className="preset-track-color__swatch"
                      style={{ backgroundColor: track.color }}
                      aria-hidden="true"
                    />
                  )}
                </div>
                <button
                  className="preset-track-delete"
                  aria-label="削除"
                  onClick={() =>
                    setTracks((current) =>
                      current
                        .filter((_item, trackIndex) => trackIndex !== index)
                        .map((item, trackIndex) => ({
                          ...item,
                          order: trackIndex + 1,
                        })),
                    )
                  }
                >
                  削除
                </button>
              </div>
            );
          })}
        </div>
        {error !== null && <p className="error-message">{error}</p>}
        <footer className="preset-editor-actions">
          <button
            className="secondary-button"
            disabled={tracks.length >= 16 || savingAction !== null}
            onClick={addTrack}
          >
            トラック追加
          </button>
          <div className="preset-editor-save-actions">
            <button
              className="secondary-button"
              disabled={!canOverwrite || savingAction !== null}
              title={
                canOverwrite
                  ? "現在のプリセットへ保存"
                  : "利用者が作成したプリセットで使用できます"
              }
              onClick={() => void save("overwrite")}
            >
              {savingAction === "overwrite" ? "保存中…" : "上書き保存"}
            </button>
            <button
              className="primary-button"
              disabled={savingAction !== null}
              onClick={() => void save("save-as")}
            >
              {savingAction === "save-as" ? "保存中…" : "別名保存"}
            </button>
          </div>
        </footer>
      </section>
    </div>
    </Localized>
  );
}
