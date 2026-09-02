import { useState } from "react";
import type { StemSeparationCapability } from "../types";
import { Localized, useAppLanguage } from "../i18n";

interface StemModelDownloadDialogProps {
  capability: StemSeparationCapability;
  onCancel(): void;
  onDownload(): Promise<void>;
}

export function StemModelDownloadDialog({
  capability,
  onCancel,
  onDownload,
}: StemModelDownloadDialogProps) {
  const { locale } = useAppLanguage();
  const [acknowledged, setAcknowledged] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sizeMiB = capability.modelSizeBytes / 1024 ** 2;

  async function download() {
    if (!acknowledged || downloading) {
      return;
    }
    setDownloading(true);
    setError(null);
    try {
      await onDownload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setDownloading(false);
    }
  }

  return (
    <Localized>
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !downloading) {
          onCancel();
        }
      }}
    >
      <section
        className="stem-model-download-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stem-model-download-title"
      >
        <h2 id="stem-model-download-title">音源分離モデルをダウンロード</h2>
        <div className="stem-model-license-warning" role="alert">
          <strong>ライセンス: {capability.licenseStatus}</strong>
          <p>
            配布ページには利用許諾条件が明示されていません。Unknownは
            利用許諾を意味しません。モデルを利用する権利を確認したうえで
            ダウンロードしてください。
          </p>
        </div>
        <p>
          アプリは次のファイルをHugging Faceからダウンロードし、受信サイズと
          SHA-256が一致した場合に音源分離モデルとして保存します。
        </p>
        <dl className="stem-model-download-details">
          <div>
            <dt>モデル</dt>
            <dd>{capability.modelName}</dd>
          </div>
          <div>
            <dt>配布ページ</dt>
            <dd>{capability.sourcePageUrl}</dd>
          </div>
          <div>
            <dt>ダウンロード容量</dt>
            <dd>
              {capability.modelSizeBytes.toLocaleString(locale)} bytes（
              {sizeMiB.toFixed(1)} MiB）
            </dd>
          </div>
          <div>
            <dt>保存先</dt>
            <dd>
              {capability.modelDirectory}\{capability.modelFileName}
            </dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd>{capability.modelSha256}</dd>
          </div>
        </dl>
        <label className="stem-model-download-confirmation">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={downloading}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          ライセンスがUnknownであり、利用許諾を確認できないことを理解しました
        </label>
        {downloading && (
          <div className="stem-model-download-progress" role="status">
            <progress aria-label="音源分離モデルをダウンロード中" />
            <span>ダウンロードとSHA-256検証を実行しています</span>
          </div>
        )}
        {error !== null && <p className="error-message">{error}</p>}
        <div className="stem-model-download-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={downloading}
            onClick={onCancel}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!acknowledged || downloading}
            onClick={() => void download()}
          >
            {downloading ? "ダウンロード中…" : "警告を確認してダウンロード"}
          </button>
        </div>
      </section>
    </div>
    </Localized>
  );
}
