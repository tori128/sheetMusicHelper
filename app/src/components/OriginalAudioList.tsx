import { Localized } from "../i18n";

interface OriginalAudioListProps {
  muted: boolean;
}

export function OriginalAudioList({ muted }: OriginalAudioListProps) {
  return (
    <Localized>
      <div className="original-audio-list" role="region" aria-label="原音">
        <div className="track-list__header">
          <span>音源</span>
          <span>1</span>
        </div>
        <div className="stem-row original-audio-row">
          <span className="stem-row__channel" aria-hidden="true">
            WAV
          </span>
          <span className="track-row__name">原音</span>
          <button
            type="button"
            className={
              muted
                ? "mini-button is-status is-active"
                : "mini-button is-status"
            }
            disabled
            aria-pressed={muted}
            aria-label="原音のミュート状態"
          >
            M
          </button>
          <button
            type="button"
            className="mini-button is-status"
            disabled
            aria-pressed="false"
            aria-label="原音のソロ状態"
          >
            S
          </button>
        </div>
      </div>
    </Localized>
  );
}
