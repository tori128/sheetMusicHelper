import type { ProjectTrack } from "../types";
import { Localized } from "../i18n";
import {
  MAX_TRACK_PLAYBACK_VOLUME,
  MIN_TRACK_PLAYBACK_VOLUME,
  trackPlaybackVolume,
} from "../track-playback-volume";

interface TrackListProps {
  tracks: ProjectTrack[];
  controlsDisabled?: boolean;
  onMute(trackId: string): void;
  onSolo(trackId: string): void;
  onPlaybackOctaveShift(trackId: string, shift: 0 | 1): void;
  onPlaybackVolume(trackId: string, volume: number): void;
}

function trackNameTooltip(track: ProjectTrack): string {
  if (track.instrumentId === "voice" && track.gmProgram === 71) {
    return `${track.displayName}\n再生音色: クラリネット`;
  }
  return track.displayName;
}

export function TrackList({
  tracks,
  controlsDisabled = false,
  onMute,
  onSolo,
  onPlaybackOctaveShift,
  onPlaybackVolume,
}: TrackListProps) {
  const soloActive = tracks.some((track) => track.solo);
  return (
    <Localized>
    <div className="track-list" role="region" aria-label="トラック一覧">
      <div className="track-list__header">
        <span>採譜結果</span>
        <span>{tracks.length}</span>
      </div>
      {tracks.map((track) => (
        <div className="track-row" key={track.id}>
          <span
            className="track-row__color"
            style={{ backgroundColor: track.color }}
            aria-hidden="true"
          />
          <div className="track-row__identity">
            <span className="track-row__name" title={trackNameTooltip(track)}>
              {track.displayName}
            </span>
            <label
              className="track-row__volume"
              title={`再生音量 ${trackPlaybackVolume(track)}%`}
            >
              <input
                type="range"
                min={MIN_TRACK_PLAYBACK_VOLUME}
                max={MAX_TRACK_PLAYBACK_VOLUME}
                step={1}
                value={trackPlaybackVolume(track)}
                disabled={controlsDisabled}
                aria-label={`${track.displayName}の再生音量`}
                onChange={(event) =>
                  onPlaybackVolume(track.id, Number(event.target.value))
                }
              />
              <output>{trackPlaybackVolume(track)}%</output>
            </label>
            {track.instrumentId === "voice" && (
              <select
                className="track-row__octave"
                aria-label={`${track.displayName}の再生オクターブ`}
                title="再生時だけ音高を変更します。書き出し音高は変わりません。"
                value={track.playbackOctaveShift}
                onChange={(event) =>
                  onPlaybackOctaveShift(
                    track.id,
                    Number(event.target.value) as 0 | 1,
                  )
                }
              >
                <option value={0}>標準</option>
                <option value={1}>+1 oct</option>
              </select>
            )}
          </div>
          <button
            className={track.mute ? "mini-button is-active" : "mini-button"}
            disabled={controlsDisabled || (soloActive && !track.solo)}
            onClick={() => onMute(track.id)}
            aria-pressed={track.mute}
            aria-label={`${track.displayName}をミュート`}
          >
            M
          </button>
          <button
            className={track.solo ? "mini-button is-solo" : "mini-button"}
            disabled={controlsDisabled}
            onClick={() => onSolo(track.id)}
            aria-pressed={track.solo}
            aria-label={`${track.displayName}をソロ`}
          >
            S
          </button>
        </div>
      ))}
    </div>
    </Localized>
  );
}
