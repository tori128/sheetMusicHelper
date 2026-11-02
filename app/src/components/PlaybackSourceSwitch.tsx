import type { PlaybackSource } from "../soundfont-playback";
import { Localized } from "../i18n";

interface PlaybackSourceSwitchProps {
  value: PlaybackSource;
  sourceDisabled?: boolean;
  transcriptionDisabled: boolean;
  onChange: (source: PlaybackSource) => void;
}

export function PlaybackSourceSwitch({
  value,
  sourceDisabled = false,
  transcriptionDisabled,
  onChange,
}: PlaybackSourceSwitchProps) {
  return (
    <Localized>
    <div className="playback-source-control">
      <span className="playback-source-label">再生</span>
      <div
        className="source-switch"
        role="group"
        aria-label="再生音を切り替え"
      >
        <button
          type="button"
          className={value === "original" ? "is-selected" : ""}
          aria-pressed={value === "original"}
          disabled={sourceDisabled}
          title={sourceDisabled ? "元音源ファイルが見つかりません" : undefined}
          onClick={() => onChange("original")}
        >
          原音
        </button>
        <button
          type="button"
          className={value === "transcription" ? "is-selected" : ""}
          aria-pressed={value === "transcription"}
          disabled={transcriptionDisabled}
          onClick={() => onChange("transcription")}
        >
          採譜結果
        </button>
        <button
          type="button"
          className={value === "comparison" ? "is-selected" : ""}
          aria-pressed={value === "comparison"}
          disabled={sourceDisabled || transcriptionDisabled}
          title={
            sourceDisabled
              ? "元音源ファイルが見つかりません"
              : "左: 原音または分離音源 / 右: 採譜結果"
          }
          onClick={() => onChange("comparison")}
        >
          左右比較
        </button>
      </div>
    </div>
    </Localized>
  );
}
