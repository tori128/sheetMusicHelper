import { X } from "lucide-react";
import { Localized } from "../i18n";
import type { SeparatedTranscriptionSettings } from "../types";
import type { TranscriptionOptionQueueState } from "../services/transcription-option-queue";
import type { PostTranscriptionOptionKey } from "../transcription-option-settings";
import type { TimingGuideReferenceAvailability } from "../transcription-option-settings";

interface PostTranscriptionOptionsProps {
  settings: SeparatedTranscriptionSettings;
  appliedSettings: SeparatedTranscriptionSettings;
  queue: TranscriptionOptionQueueState;
  disabled: boolean;
  timingGuideReferences: TimingGuideReferenceAvailability;
  onChange(option: PostTranscriptionOptionKey, checked: boolean): void;
  onCancel(): void;
  onClose(): void;
}

const OPTIONS: ReadonlyArray<{
  key: PostTranscriptionOptionKey;
  label: string;
  description: string;
}> = [
  {
    key: "velocityFromStemAmplitude",
    label: "分離後音源の音量からベロシティを設定する",
    description: "各音符の発音開始から200 ms以内について、対応する分離後音源の20 ms実効値を測定し、固定したdBFS尺度でベロシティ1〜127へ変換します。",
  },
  {
    key: "timingGuideNoteFilter",
    label: "ドラム成分の追加による音高の誤検出を削減する",
    description: "Bass、Piano、Guitar、Otherをドラム成分の有無で採譜し、ドラム成分なしの結果で同じMIDI音高が検出されない音符を除外します。ドラム成分なしの1音が時間区間を含み、先行音符の終了位置と後続音符の発音開始位置の差が±20 ms以内にある同一音高・同一パートの隣接音符も結合します。対象パートの採譜回数は2回になります。",
  },
];

function optionStatus(
  key: PostTranscriptionOptionKey,
  settings: SeparatedTranscriptionSettings,
  appliedSettings: SeparatedTranscriptionSettings,
  queue: TranscriptionOptionQueueState,
  unavailableStatus: string | null = null,
): string {
  if (queue.runningOption === key) {
    return "適用中";
  }
  if (queue.pendingOptions.includes(key)) {
    return "待機";
  }
  if (unavailableStatus !== null) {
    return unavailableStatus;
  }
  if (settings[key] !== appliedSettings[key]) {
    return "反映待ち";
  }
  return appliedSettings[key] ? "有効" : "無効";
}

export function PostTranscriptionOptions({
  settings,
  appliedSettings,
  queue,
  disabled,
  timingGuideReferences,
  onChange,
  onCancel,
  onClose,
}: PostTranscriptionOptionsProps) {
  const progress =
    queue.total > 0 ? Math.round((queue.completed / queue.total) * 100) : null;
  return (
    <Localized>
    <section className="post-transcription-options" aria-labelledby="post-options-title">
      <div className="post-transcription-options__heading">
        <div className="post-transcription-options__heading-copy">
          <h2 id="post-options-title">採譜オプション</h2>
          <span>変更した順に適用します</span>
        </div>
        <div className="post-transcription-options__actions">
          <button
            type="button"
            className="icon-button"
            aria-label="採譜オプションを閉じる"
            title="採譜オプションを閉じる"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      {OPTIONS.map((option) => {
        const guideUnavailable =
          option.key === "timingGuideNoteFilter" && !settings.drumOnsetGuide;
        const referenceCollectionRequired =
          option.key === "timingGuideNoteFilter" &&
          !settings.timingGuideNoteFilter &&
          timingGuideReferences.hasApplicablePrimary &&
          timingGuideReferences.missingInputNames.length > 0;
        const referencesUnavailable =
          option.key === "timingGuideNoteFilter" &&
          !settings.timingGuideNoteFilter &&
          !timingGuideReferences.hasApplicablePrimary;
        const referenceMessage = referenceCollectionRequired
          ? `ONにするとdrums無加算採譜を実行します: ${timingGuideReferences.missingInputNames.join(", ")}`
          : !referencesUnavailable
          ? null
          : "保存済みのdrums追加後採譜結果がありません";
        return (
          <label className="post-transcription-option" key={option.key}>
            <input
              type="checkbox"
              checked={guideUnavailable ? false : settings[option.key]}
              disabled={disabled || guideUnavailable || referencesUnavailable}
              onChange={(event) => onChange(option.key, event.target.checked)}
            />
            <span className="post-transcription-option__text">
              <strong>{option.label}</strong>
              <small>{option.description}</small>
              {referenceMessage !== null && <small>{referenceMessage}</small>}
            </span>
            <span className="post-transcription-option__status">
              {optionStatus(
                option.key,
                settings,
                appliedSettings,
                queue,
                referenceCollectionRequired
                  ? "追加採譜が必要"
                  : referencesUnavailable
                    ? "参照結果なし"
                    : null,
              )}
            </span>
          </label>
        );
      })}
      {queue.status === "running" && (
        <div className="post-transcription-options__progress" aria-live="polite">
          <div className="post-transcription-options__progress-summary">
            <span>{queue.detail ?? "採譜オプションを適用しています"}</span>
            <button type="button" onClick={onCancel}>キャンセル</button>
          </div>
          {progress !== null && <progress max="100" value={progress} />}
          {queue.pendingOptions.length > 0 && (
            <span>待機 {queue.pendingOptions.length}件</span>
          )}
        </div>
      )}
      {queue.status === "failed" && (
        <p className="post-transcription-options__error" role="alert">
          {queue.error}
        </p>
      )}
    </section>
    </Localized>
  );
}
