import { useState } from "react";
import type {
  InstrumentDefinition,
  PresetDefinition,
  PresetTrackDefinition,
} from "../types";

interface PresetEditorProps {
  instruments: InstrumentDefinition[];
  preset: PresetDefinition;
  onCancel(): void;
  onSave(name: string, tracks: PresetTrackDefinition[]): Promise<void>;
}

export function PresetEditor({
  instruments,
  preset,
  onCancel,
  onSave,
}: PresetEditorProps) {
  const [name, setName] = useState(`${preset.name} コピー`);
  const [tracks, setTracks] = useState<PresetTrackDefinition[]>(
    preset.tracks.map((track) => ({ ...track })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function replaceTrack(
    index: number,
    update: Partial<PresetTrackDefinition>,
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
        color: "#4C9AFF",
        kind: instrument.kind,
        order: current.length + 1,
      },
    ]);
  }

  async function save() {
    if (!name.trim() || tracks.length === 0) {
      setError("プリセット名と1件以上のトラックが必要です");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(
        name.trim(),
        tracks.map((track, index) => ({ ...track, order: index + 1 })),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
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
          {tracks.map((track, index) => (
            <div className="preset-track-row" key={index}>
              <span>{index + 1}</span>
              <button
                aria-label="上へ"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
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
                    });
                  }
                }}
              >
                {instruments.map((instrument) => (
                  <option key={instrument.id} value={instrument.id}>
                    {instrument.displayNameJa}
                  </option>
                ))}
              </select>
              <input
                aria-label="トラック色"
                type="color"
                value={track.color}
                onChange={(event) =>
                  replaceTrack(index, { color: event.target.value })
                }
              />
              <button
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
          ))}
        </div>
        {error !== null && <p className="error-message">{error}</p>}
        <footer className="preset-editor-actions">
          <button
            className="secondary-button"
            disabled={tracks.length >= 16 || saving}
            onClick={addTrack}
          >
            トラック追加
          </button>
          <button
            className="primary-button"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "別名保存"}
          </button>
        </footer>
      </section>
    </div>
  );
}
