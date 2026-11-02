import {
  STEM_DISPLAY_NAMES,
  STEM_DISPLAY_ORDER,
} from "../stem-playback";
import type { ProjectStem, StemType } from "../types";
import { Localized } from "../i18n";

interface StemListProps {
  stems: ProjectStem[];
  controlsDisabled?: boolean;
  onMute(stemType: StemType): void;
  onSolo(stemType: StemType): void;
}

export function StemList({
  stems,
  controlsDisabled = false,
  onMute,
  onSolo,
}: StemListProps) {
  const ordered = [...stems].sort(
    (left, right) =>
      STEM_DISPLAY_ORDER.indexOf(left.type) -
      STEM_DISPLAY_ORDER.indexOf(right.type),
  );
  const soloActive = ordered.some((stem) => stem.solo);
  return (
    <Localized>
    <div className="stem-list" role="region" aria-label="分離音源一覧">
      <div className="track-list__header">
        <span>分離音源</span>
        <span>{ordered.length}</span>
      </div>
      {ordered.map((stem) => {
        const name = STEM_DISPLAY_NAMES[stem.type];
        return (
          <div className="stem-row" key={stem.type}>
            <span className="stem-row__channel" aria-hidden="true">
              WAV
            </span>
            <span className="track-row__name">{name}</span>
            <button
              className={stem.mute ? "mini-button is-active" : "mini-button"}
              disabled={controlsDisabled || (soloActive && !stem.solo)}
              onClick={() => onMute(stem.type)}
              aria-pressed={stem.mute}
              aria-label={`${name}分離音源をミュート`}
            >
              M
            </button>
            <button
              className={stem.solo ? "mini-button is-solo" : "mini-button"}
              disabled={controlsDisabled}
              onClick={() => onSolo(stem.type)}
              aria-pressed={stem.solo}
              aria-label={`${name}分離音源をソロ`}
            >
              S
            </button>
          </div>
        );
      })}
    </div>
    </Localized>
  );
}
