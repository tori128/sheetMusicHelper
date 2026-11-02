import { useEffect, useMemo, useState } from "react";
import { Database, Headphones, Trash2, X } from "lucide-react";
import type { LocalApiClient } from "../api";
import {
  readAudioOutputDeviceId,
  writeAudioOutputDeviceId,
} from "../audio-output-settings";
import {
  MAX_SOURCE_PLAYBACK_DELAY_MS,
  MIN_SOURCE_PLAYBACK_DELAY_MS,
  readSourcePlaybackDelayMs,
  writeSourcePlaybackDelayMs,
} from "../playback-sync-settings";
import {
  normalizeAudioOutputDevices,
  type AudioOutputDevice,
} from "../soundfont-playback";
import type { CacheEntry } from "../types";
import { Localized, useAppLanguage } from "../i18n";
import { LanguageSelect } from "./LanguageSelect";

interface SettingsDialogProps {
  client: LocalApiClient;
  onClose(): void;
  onAudioOutputDeviceChange?(deviceId: string): Promise<void> | void;
  onSourcePlaybackDelayChange?(delayMs: number): void;
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 ** 2) {
    return `${(size / 1024).toFixed(1)} KiB`;
  }
  if (size < 1024 ** 3) {
    return `${(size / 1024 ** 2).toFixed(1)} MiB`;
  }
  return `${(size / 1024 ** 3).toFixed(1)} GiB`;
}

const CACHE_KIND_LABELS: Record<string, string> = {
  audio: "解析用音声",
  stems: "分離音源",
  transcriptions: "採譜結果",
};

function cacheKindLabel(kind: string): string {
  return CACHE_KIND_LABELS[kind] ?? kind;
}

export function SettingsDialog({
  client,
  onClose,
  onAudioOutputDeviceChange,
  onSourcePlaybackDelayChange,
}: SettingsDialogProps) {
  const { locale, t } = useAppLanguage();
  const [activeTab, setActiveTab] = useState<"playback" | "cache">(
    "playback",
  );
  const [entries, setEntries] = useState<CacheEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cacheLoaded, setCacheLoaded] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [outputDeviceBusy, setOutputDeviceBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([]);
  const [outputDeviceId, setOutputDeviceId] = useState(
    readAudioOutputDeviceId,
  );
  const [sourcePlaybackDelayMs, setSourcePlaybackDelayMs] = useState(
    readSourcePlaybackDelayMs,
  );
  const totalSize = useMemo(
    () => entries.reduce((total, entry) => total + entry.sizeBytes, 0),
    [entries],
  );
  const allEntriesSelected =
    entries.length > 0 && entries.every((entry) => selected.has(entry.id));

  useEffect(() => {
    if (activeTab !== "cache" || cacheLoaded) {
      return;
    }
    let active = true;
    setCacheBusy(true);
    void client.cacheEntries
      .then((result) => {
        if (active) {
          setEntries(result);
          setCacheLoaded(true);
        }
      })
      .catch((reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (active) {
          setCacheBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [activeTab, cacheLoaded, client]);

  useEffect(() => {
    let active = true;
    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices?.enumerateDevices === undefined) {
      setOutputDevices([{ deviceId: "default", label: "既定の出力" }]);
      setOutputDeviceId("default");
      writeAudioOutputDeviceId("default");
      return () => {
        active = false;
      };
    }
    void mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (!active) {
          return;
        }
        const normalized = normalizeAudioOutputDevices(devices);
        const available =
          normalized.length > 0
            ? normalized
            : [{ deviceId: "default", label: "既定の出力" }];
        setOutputDevices(available);
        setOutputDeviceId((current) => {
          if (available.some((device) => device.deviceId === current)) {
            return current;
          }
          const fallback = available[0]?.deviceId ?? "default";
          writeAudioOutputDeviceId(fallback);
          return fallback;
        });
      })
      .catch((reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function selectAudioOutputDevice(deviceId: string) {
    const previous = outputDeviceId;
    setOutputDeviceBusy(true);
    setError(null);
    try {
      await onAudioOutputDeviceChange?.(deviceId);
      setOutputDeviceId(writeAudioOutputDeviceId(deviceId));
    } catch (reason) {
      setOutputDeviceId(previous);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOutputDeviceBusy(false);
    }
  }

  async function deleteSelected() {
    if (
      selected.size === 0 ||
      !window.confirm(t(`選択したキャッシュ${selected.size}件を削除しますか？`))
    ) {
      return;
    }
    setCacheBusy(true);
    setError(null);
    try {
      for (const entryId of selected) {
        await client.deleteCacheEntry(entryId);
      }
      setEntries((current) =>
        current.filter((entry) => !selected.has(entry.id)),
      );
      setSelected(new Set());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCacheBusy(false);
    }
  }

  return (
    <Localized>
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="settings-dialog__header">
          <div>
            <h2 id="settings-title">設定</h2>
            <span>
              {activeTab === "playback"
                ? "オーディオ出力と比較再生"
                : `キャッシュ ${formatBytes(totalSize)}（種類ごとに最終使用10件を保持）`}
            </span>
          </div>
          <button
            className="secondary-button icon-button"
            aria-label="閉じる"
            title="閉じる"
            onClick={onClose}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <LanguageSelect className="settings-language-select" />

        <div className="settings-tabs" role="tablist" aria-label="設定項目">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "playback"}
            className={activeTab === "playback" ? "is-selected" : ""}
            onClick={() => setActiveTab("playback")}
          >
            <Headphones size={16} aria-hidden="true" />
            再生
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "cache"}
            className={activeTab === "cache" ? "is-selected" : ""}
            onClick={() => setActiveTab("cache")}
          >
            <Database size={16} aria-hidden="true" />
            キャッシュ
          </button>
        </div>

        {activeTab === "playback" && (
          <section
            className="playback-sync-settings settings-panel"
            aria-label="再生設定"
          >
            <label>
              <span>オーディオ出力デバイス</span>
              <select
                aria-label="オーディオ出力デバイス"
                value={outputDeviceId}
                disabled={outputDeviceBusy || outputDevices.length === 0}
                onChange={(event) =>
                  void selectAudioOutputDevice(event.target.value)
                }
              >
                {outputDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="timing-correction-setting">
              <span>再生位置オフセット</span>
              <span className="timing-correction-control">
                <input
                  id="source-playback-delay"
                  aria-label="再生位置オフセット"
                  type="range"
                  min={MIN_SOURCE_PLAYBACK_DELAY_MS}
                  max={MAX_SOURCE_PLAYBACK_DELAY_MS}
                  step={1}
                  value={sourcePlaybackDelayMs}
                  onChange={(event) => {
                    const value = writeSourcePlaybackDelayMs(
                      Number(event.target.value),
                    );
                    setSourcePlaybackDelayMs(value);
                    onSourcePlaybackDelayChange?.(value);
                  }}
                />
                <output htmlFor="source-playback-delay">
                  {sourcePlaybackDelayMs > 0 ? "+" : ""}
                  {sourcePlaybackDelayMs} ms
                </output>
              </span>
              <span className="field-description">
                正の値は原音、負の値は採譜結果を遅らせます。
              </span>
            </label>
          </section>
        )}

        {error && <p className="error-message">{error}</p>}
        {activeTab === "cache" && (
          <section
            className="settings-panel settings-cache-panel"
            aria-label="キャッシュ設定"
          >
            <div className="cache-table-wrap">
              <table className="cache-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="すべてのキャッシュを選択"
                        checked={allEntriesSelected}
                        disabled={cacheBusy || entries.length === 0}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? new Set(entries.map((entry) => entry.id))
                              : new Set(),
                          )
                        }
                      />
                    </th>
                    <th>種類</th>
                    <th>識別子</th>
                    <th>使用量</th>
                    <th>最終使用</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${entry.id}を選択`}
                          checked={selected.has(entry.id)}
                          disabled={cacheBusy}
                          onChange={(event) => {
                            const next = new Set(selected);
                            if (event.target.checked) {
                              next.add(entry.id);
                            } else {
                              next.delete(entry.id);
                            }
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td>{cacheKindLabel(entry.kind)}</td>
                      <td title={entry.id}>{entry.id}</td>
                      <td>{formatBytes(entry.sizeBytes)}</td>
                      <td>{new Date(entry.modifiedAt).toLocaleString(locale)}</td>
                    </tr>
                  ))}
                  {cacheBusy && entries.length === 0 && (
                    <tr>
                      <td colSpan={5}>読み込み中…</td>
                    </tr>
                  )}
                  {!cacheBusy && entries.length === 0 && (
                    <tr>
                      <td colSpan={5}>キャッシュなし</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <footer className="settings-dialog__actions">
              <span>{selected.size}件選択</span>
              <button
                className="secondary-button button-with-icon danger-button"
                disabled={cacheBusy || selected.size === 0}
                onClick={() => void deleteSelected()}
              >
                <Trash2 size={15} aria-hidden="true" />
                選択項目を削除
              </button>
            </footer>
          </section>
        )}
      </section>
    </div>
    </Localized>
  );
}
