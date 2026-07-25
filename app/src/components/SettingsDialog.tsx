import { useEffect, useMemo, useState } from "react";
import type { LocalApiClient } from "../api";
import type { CacheEntry } from "../types";

interface SettingsDialogProps {
  client: LocalApiClient;
  onClose(): void;
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

export function SettingsDialog({ client, onClose }: SettingsDialogProps) {
  const [entries, setEntries] = useState<CacheEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const totalSize = useMemo(
    () => entries.reduce((total, entry) => total + entry.sizeBytes, 0),
    [entries],
  );

  useEffect(() => {
    let active = true;
    void client.cacheEntries
      .then((result) => {
        if (active) {
          setEntries(result);
        }
      })
      .catch((reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (active) {
          setBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  async function deleteSelected() {
    if (
      selected.size === 0 ||
      !window.confirm(`選択したキャッシュ${selected.size}件を削除しますか？`)
    ) {
      return;
    }
    setBusy(true);
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
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
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
            <span>キャッシュ {formatBytes(totalSize)}</span>
          </div>
          <button className="secondary-button" disabled={busy} onClick={onClose}>
            閉じる
          </button>
        </header>

        {error && <p className="error-message">{error}</p>}
        <div className="cache-table-wrap">
          <table className="cache-table">
            <thead>
              <tr>
                <th aria-label="選択" />
                <th>種類</th>
                <th>識別子</th>
                <th>使用量</th>
                <th>最終更新</th>
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
                      disabled={busy}
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
                  <td>{entry.kind}</td>
                  <td title={entry.id}>{entry.id}</td>
                  <td>{formatBytes(entry.sizeBytes)}</td>
                  <td>{new Date(entry.modifiedAt).toLocaleString("ja-JP")}</td>
                </tr>
              ))}
              {!busy && entries.length === 0 && (
                <tr>
                  <td colSpan={5}>キャッシュなし</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <footer className="settings-dialog__actions">
          <button
            className="secondary-button"
            disabled={busy || selected.size === 0}
            onClick={() => void deleteSelected()}
          >
            選択項目を削除
          </button>
        </footer>
      </section>
    </div>
  );
}
