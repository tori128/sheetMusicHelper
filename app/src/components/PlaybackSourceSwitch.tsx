import type { PlaybackSource } from "../soundfont-playback";

interface PlaybackSourceSwitchProps {
  value: PlaybackSource;
  transcriptionDisabled: boolean;
  onChange: (source: PlaybackSource) => void;
}

export function PlaybackSourceSwitch({
  value,
  transcriptionDisabled,
  onChange,
}: PlaybackSourceSwitchProps) {
  return (
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
      </div>
    </div>
  );
}
