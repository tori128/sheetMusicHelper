import type { ProjectNote, ProjectTrack } from "../types";

export function visibleTracksForSolo(
  tracks: ProjectTrack[],
): ProjectTrack[] {
  const soloTracks = tracks.filter((track) => track.solo);
  return soloTracks.length > 0 ? soloTracks : tracks;
}

export function visibleNotesForRoll(
  notes: ProjectNote[],
  tracks: ProjectTrack[],
  mode: "pitched" | "drums",
): ProjectNote[] {
  const visibleTrackIds = new Set(
    visibleTracksForSolo(tracks)
      .filter((track) => track.kind === mode)
      .map((track) => track.id),
  );
  return notes.filter((note) => visibleTrackIds.has(note.trackId));
}
