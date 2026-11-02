import type { ProjectNote, ProjectTrack } from "../types";

export function visibleTracksForRoll(
  tracks: ProjectTrack[],
): ProjectTrack[] {
  const soloTracks = tracks.filter((track) => track.solo);
  if (soloTracks.length > 0) {
    return soloTracks;
  }

  const unmutedTracks = tracks.filter((track) => !track.mute);
  return unmutedTracks.length > 0 ? unmutedTracks : tracks;
}

export function visibleNotesForRoll(
  notes: ProjectNote[],
  tracks: ProjectTrack[],
  mode: "pitched" | "drums",
): ProjectNote[] {
  const visibleTrackIds = new Set(
    visibleTracksForRoll(tracks)
      .filter((track) => track.kind === mode)
      .map((track) => track.id),
  );
  return notes.filter((note) => visibleTrackIds.has(note.trackId));
}
