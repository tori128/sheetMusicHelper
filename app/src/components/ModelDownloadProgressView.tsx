import type { ModelDownloadProgress } from "../types";
import { useAppLanguage } from "../i18n";

const phases: Record<ModelDownloadProgress["phase"], string> = {
  preparing: "取得を準備中…",
  downloading: "ダウンロード中…",
  verifying: "SHA-256を検証中…",
  assembling: "分割ファイルを結合中…",
  extracting: "モデルを展開中…",
  registering: "モデルを登録中…",
};

export function ModelDownloadProgressView({ progress, label }: { progress: ModelDownloadProgress | null; label: string }) {
  const { t, locale } = useAppLanguage();
  const percentage = progress && progress.totalBytes > 0
    ? Math.floor(progress.completedBytes / progress.totalBytes * 100) : undefined;
  const size = (bytes: number) => (bytes / 1024 ** 2).toLocaleString(locale, { maximumFractionDigits: 1 });
  return <div className="stem-model-download-progress" role="status">
    <progress aria-label={t(label)} max={100} value={percentage} />
    <span>{t(phases[progress?.phase ?? "preparing"])}{percentage !== undefined && ` ${percentage}%`}</span>
    {progress && progress.totalBytes > 0 && <span>{size(progress.completedBytes)} / {size(progress.totalBytes)} MiB</span>}
  </div>;
}
