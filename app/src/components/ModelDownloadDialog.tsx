import { useEffect, useState } from "react";
import type { LocalApiClient } from "../api";
import { ModelDownloadProgressView } from "./ModelDownloadProgressView";
import type { ModelDownloadProgress, ModelDownloadProgressCallback, ModelDownloadOption, ModelVariant } from "../types";
import { Localized, useAppLanguage } from "../i18n";

interface ModelDownloadDialogProps {
  client: LocalApiClient;
  onCancel(): void;
  onDownload(variant: ModelVariant, onProgress: ModelDownloadProgressCallback): Promise<void>;
}

export function ModelDownloadDialog({ client, onCancel, onDownload }: ModelDownloadDialogProps) {
  const { locale } = useAppLanguage();
  const [options, setOptions] = useState<ModelDownloadOption[] | null>(null);
  const [variant, setVariant] = useState<ModelVariant>("medium");
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const selected = options?.find((option) => option.variant === variant);

  useEffect(() => {
    let closed = false;
    setOptions(null);
    setError(null);
    client.modelDownloads.then((value) => {
      if (!closed) setOptions(value);
    }).catch((reason) => {
      if (!closed) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { closed = true; };
  }, [client, attempt]);

  async function download() {
    if (selected === undefined || selected.installed || downloading) return;
    setDownloading(true);
    setProgress(null);
    setError(null);
    try {
      await onDownload(variant, setProgress);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setDownloading(false);
    }
  }

  const size = (bytes: number) => `${(bytes / 1_000_000_000).toLocaleString(locale, { maximumFractionDigits: 2 })} GB`;

  return (
    <Localized>
      <div className="modal-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !downloading) onCancel();
      }}>
        <section className="stem-model-download-dialog" role="dialog" aria-modal="true" aria-labelledby="model-download-title">
          <h2 id="model-download-title">採譜モデルを取得</h2>
          <p>mediumは標準の採譜モデルです。smallとlargeも追加できます。</p>
          <label className="form-field">
            <span>取得するモデル</span>
            <select value={variant} disabled={downloading || options === null} onChange={(event) => setVariant(event.target.value as ModelVariant)}>
              <option value="medium">medium（標準）</option>
              <option value="small">small</option>
              <option value="large">large</option>
            </select>
          </label>
          {selected !== undefined && (
            <dl className="stem-model-download-details">
              <div><dt>ダウンロード容量</dt><dd>{size(selected.downloadSizeBytes)}</dd></div>
              <div><dt>必要な空き容量</dt><dd>{size(selected.requiredSpaceBytes)}</dd></div>
            </dl>
          )}
          <p>取得後は自動で登録され、採譜に使用できます。</p>
          {options === null && error === null && <p role="status">モデル情報を取得中…</p>}
          {downloading && <ModelDownloadProgressView progress={progress} label="採譜モデルを取得中" />}
          {error !== null && <p className="error-message" role="alert">{error}</p>}
          <div className="stem-model-download-actions">
            <button type="button" className="secondary-button" disabled={downloading} onClick={onCancel}>キャンセル</button>
            {options === null && error !== null ? (
              <button type="button" className="primary-button" onClick={() => setAttempt(attempt + 1)}>再読み込み</button>
            ) : (
              <button type="button" className="primary-button" disabled={selected === undefined || selected.installed || downloading} onClick={() => void download()}>
                {downloading ? "取得中…" : selected?.installed ? "取得済み" : "取得して使用"}
              </button>
            )}
          </div>
        </section>
      </div>
    </Localized>
  );
}
