import type { ProjectTrack } from "../types";

interface TrackListProps {
  tracks: ProjectTrack[];
  onMute(trackId: string): void;
  onSolo(trackId: string): void;
}

export function TrackList({ tracks, onMute, onSolo }: TrackListProps) {
  return (
    <aside className="track-list" aria-label="トラック一覧">
      <div className="track-list__header">
        <span>TRACKS</span>
        <span>{tracks.length}</span>
      </div>
      {tracks.map((track) => (
        <div className="track-row" key={track.id}>
          <span
            className="track-row__color"
            style={{ backgroundColor: track.color }}
            aria-hidden="true"
          />
          <span className="track-row__name" title={track.displayName}>
            {track.displayName}
          </span>
          <button
            className={track.mute ? "mini-button is-active" : "mini-button"}
            onClick={() => onMute(track.id)}
            aria-pressed={track.mute}
          >
            M
          </button>
          <button
            className={track.solo ? "mini-button is-solo" : "mini-button"}
            onClick={() => onSolo(track.id)}
            aria-pressed={track.solo}
          >
            S
          </button>
        </div>
      ))}
    </aside>
  );
}

