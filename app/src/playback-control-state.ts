import type { PlaybackSource } from "./soundfont-playback";
import { stemTypeForTrack } from "./stem-playback";
import type { ProjectStem, ProjectTrack, StemType } from "./types";

export interface PlaybackControlState {
  tracks: ProjectTrack[];
  stems: ProjectStem[];
}

function hasTrackSolo(tracks: readonly ProjectTrack[]): boolean {
  return tracks.some((track) => track.solo);
}

function hasStemSolo(stems: readonly ProjectStem[]): boolean {
  return stems.some((stem) => stem.solo);
}

function applyTrackSoloSelection(
  tracks: readonly ProjectTrack[],
  soloIds: ReadonlySet<string>,
  mutedSoloIds: ReadonlySet<string>,
): ProjectTrack[] {
  if (soloIds.size === 0) {
    return tracks.map((track) => ({ ...track, mute: false, solo: false }));
  }
  return tracks.map((track) => {
    const solo = soloIds.has(track.id);
    return {
      ...track,
      solo,
      mute: solo ? mutedSoloIds.has(track.id) : true,
    };
  });
}

function applyStemSoloSelection(
  stems: readonly ProjectStem[],
  soloTypes: ReadonlySet<StemType>,
  mutedSoloTypes: ReadonlySet<StemType>,
): ProjectStem[] {
  if (soloTypes.size === 0) {
    return stems.map((stem) => ({ ...stem, mute: false, solo: false }));
  }
  return stems.map((stem) => {
    const solo = soloTypes.has(stem.type);
    return {
      ...stem,
      solo,
      mute: solo ? mutedSoloTypes.has(stem.type) : true,
    };
  });
}

export function addTrackToPlaybackControlState(
  source: PlaybackSource,
  track: ProjectTrack,
  tracks: readonly ProjectTrack[],
  stems: readonly ProjectStem[],
): PlaybackControlState {
  const pairedStem =
    source === "comparison"
      ? stems.find((stem) => stem.type === stemTypeForTrack(track))
      : undefined;
  const solo = pairedStem?.solo ?? false;
  const soloActive = hasTrackSolo(tracks) || solo;
  const mute = soloActive
    ? solo
      ? (pairedStem?.mute ?? false)
      : true
    : (pairedStem?.mute ?? source === "original");
  return {
    tracks: [...tracks, { ...track, mute, solo }],
    stems: [...stems],
  };
}

export function addStemToPlaybackControlState(
  source: PlaybackSource,
  stem: ProjectStem,
  tracks: readonly ProjectTrack[],
  stems: readonly ProjectStem[],
): PlaybackControlState {
  const pairedTracks =
    source === "comparison"
      ? tracks.filter((track) => stemTypeForTrack(track) === stem.type)
      : [];
  const pairedSoloTracks = pairedTracks.filter((track) => track.solo);
  const solo = pairedSoloTracks.length > 0;
  const soloActive = hasStemSolo(stems) || solo;
  const mute = soloActive
    ? solo
      ? pairedSoloTracks.every((track) => track.mute)
      : true
    : pairedTracks.some((track) => track.mute) || source === "transcription";
  const synchronizedTracks =
    source === "comparison" && pairedTracks.length > 0 && !solo
      ? tracks.map((track) =>
          stemTypeForTrack(track) === stem.type
            ? { ...track, mute, solo: false }
            : track,
        )
      : [...tracks];
  return {
    tracks: synchronizedTracks,
    stems: [...stems, { ...stem, mute, solo }],
  };
}

export function resetPlaybackControlState(
  source: PlaybackSource,
  tracks: readonly ProjectTrack[],
  stems: readonly ProjectStem[],
): PlaybackControlState {
  return {
    tracks: tracks.map((track) => ({
      ...track,
      mute: source === "original",
      solo: false,
    })),
    stems: stems.map((stem) => ({
      ...stem,
      mute: source === "transcription",
      solo: false,
    })),
  };
}

export function toggleTrackMuteState(
  source: PlaybackSource,
  trackId: string,
  tracks: readonly ProjectTrack[],
  stems: readonly ProjectStem[],
): PlaybackControlState {
  const target = tracks.find((track) => track.id === trackId);
  if (target === undefined) {
    throw new Error(`トラックが見つかりません: ${trackId}`);
  }
  const trackSoloActive = hasTrackSolo(tracks);
  if (trackSoloActive && !target.solo) {
    return { tracks: [...tracks], stems: [...stems] };
  }

  const mute = !target.mute;
  const pairedStemType =
    source === "comparison" ? stemTypeForTrack(target) : null;
  const hasPairedStem =
    pairedStemType !== null &&
    stems.some((stem) => stem.type === pairedStemType);
  return {
    tracks: tracks.map((track) => {
      const affected =
        track.id === trackId ||
        (hasPairedStem && stemTypeForTrack(track) === pairedStemType);
      if (!affected) {
        return track;
      }
      return {
        ...track,
        mute: trackSoloActive && !track.solo ? true : mute,
      };
    }),
    stems: stems.map((stem) =>
      hasPairedStem && stem.type === pairedStemType
        ? { ...stem, mute }
        : stem,
    ),
  };
}

export function toggleStemMuteState(
  source: PlaybackSource,
  stemType: StemType,
  tracks: readonly ProjectTrack[],
  stems: readonly ProjectStem[],
): PlaybackControlState {
  const target = stems.find((stem) => stem.type === stemType);
  if (target === undefined) {
    throw new Error(`分離音源が見つかりません: ${stemType}`);
  }
  const stemSoloActive = hasStemSolo(stems);
  if (stemSoloActive && !target.solo) {
    return { tracks: [...tracks], stems: [...stems] };
  }

  const mute = !target.mute;
  const trackSoloActive = hasTrackSolo(tracks);
  return {
    tracks: tracks.map((track) => {
      if (source !== "comparison" || stemTypeForTrack(track) !== stemType) {
        return track;
      }
      return {
        ...track,
        mute: trackSoloActive && !track.solo ? true : mute,
      };
    }),
    stems: stems.map((stem) =>
      stem.type === stemType ? { ...stem, mute } : stem,
    ),
  };
}

export function toggleTrackSoloState(
  source: PlaybackSource,
  trackId: string,
  tracks: readonly ProjectTrack[],
  stems: readonly ProjectStem[],
): PlaybackControlState {
  const target = tracks.find((track) => track.id === trackId);
  if (target === undefined) {
    throw new Error(`トラックが見つかりません: ${trackId}`);
  }

  const trackSoloIds = new Set(
    tracks.filter((track) => track.solo).map((track) => track.id),
  );
  const mutedTrackSoloIds = new Set(
    tracks
      .filter((track) => track.solo && track.mute)
      .map((track) => track.id),
  );
  const selecting = !target.solo;
  if (selecting) {
    trackSoloIds.add(trackId);
  } else {
    trackSoloIds.delete(trackId);
  }
  mutedTrackSoloIds.delete(trackId);

  let nextStems = [...stems];
  if (source === "comparison") {
    const pairedStemType = stemTypeForTrack(target);
    if (stems.some((stem) => stem.type === pairedStemType)) {
      const stemSoloTypes = new Set(
        stems.filter((stem) => stem.solo).map((stem) => stem.type),
      );
      const mutedStemSoloTypes = new Set(
        stems
          .filter((stem) => stem.solo && stem.mute)
          .map((stem) => stem.type),
      );
      if (selecting) {
        stemSoloTypes.add(pairedStemType);
        mutedStemSoloTypes.delete(pairedStemType);
        for (const soloTrackId of trackSoloIds) {
          const soloTrack = tracks.find((track) => track.id === soloTrackId);
          if (
            soloTrack !== undefined &&
            stemTypeForTrack(soloTrack) === pairedStemType
          ) {
            mutedTrackSoloIds.delete(soloTrackId);
          }
        }
      } else {
        const sameStemStillSolo = tracks.some(
          (track) =>
            track.id !== trackId &&
            trackSoloIds.has(track.id) &&
            stemTypeForTrack(track) === pairedStemType,
        );
        if (!sameStemStillSolo) {
          stemSoloTypes.delete(pairedStemType);
          mutedStemSoloTypes.delete(pairedStemType);
        }
      }
      nextStems = applyStemSoloSelection(
        stems,
        stemSoloTypes,
        mutedStemSoloTypes,
      );
    }
  }

  return {
    tracks: applyTrackSoloSelection(
      tracks,
      trackSoloIds,
      mutedTrackSoloIds,
    ),
    stems: nextStems,
  };
}

export function toggleStemSoloState(
  source: PlaybackSource,
  stemType: StemType,
  tracks: readonly ProjectTrack[],
  stems: readonly ProjectStem[],
): PlaybackControlState {
  const target = stems.find((stem) => stem.type === stemType);
  if (target === undefined) {
    throw new Error(`分離音源が見つかりません: ${stemType}`);
  }

  const stemSoloTypes = new Set(
    stems.filter((stem) => stem.solo).map((stem) => stem.type),
  );
  const mutedStemSoloTypes = new Set(
    stems
      .filter((stem) => stem.solo && stem.mute)
      .map((stem) => stem.type),
  );
  const selecting = !target.solo;
  if (selecting) {
    stemSoloTypes.add(stemType);
  } else {
    stemSoloTypes.delete(stemType);
  }
  mutedStemSoloTypes.delete(stemType);

  let nextTracks = [...tracks];
  if (source === "comparison") {
    const relatedTracks = tracks.filter(
      (track) => stemTypeForTrack(track) === stemType,
    );
    if (relatedTracks.length > 0) {
      const trackSoloIds = new Set(
        tracks.filter((track) => track.solo).map((track) => track.id),
      );
      const mutedTrackSoloIds = new Set(
        tracks
          .filter((track) => track.solo && track.mute)
          .map((track) => track.id),
      );
      for (const track of relatedTracks) {
        if (selecting) {
          trackSoloIds.add(track.id);
        } else {
          trackSoloIds.delete(track.id);
        }
        mutedTrackSoloIds.delete(track.id);
      }
      nextTracks = applyTrackSoloSelection(
        tracks,
        trackSoloIds,
        mutedTrackSoloIds,
      );
    }
  }

  return {
    tracks: nextTracks,
    stems: applyStemSoloSelection(stems, stemSoloTypes, mutedStemSoloTypes),
  };
}
