import type { PlaybackSource } from "./soundfont-playback";
import type { ProjectStem, ProjectTrack, StemType } from "./types";

const BASS_INSTRUMENT_IDS = new Set([
  "acoustic_bass",
  "electric_bass",
  "contrabass",
]);
const PIANO_INSTRUMENT_IDS = new Set([
  "acoustic_piano",
  "electric_piano",
]);
const GUITAR_INSTRUMENT_IDS = new Set([
  "acoustic_guitar",
  "clean_electric_guitar",
  "distorted_electric_guitar",
]);

export const STEM_DISPLAY_ORDER: readonly StemType[] = [
  "drums",
  "bass",
  "vocals",
  "piano",
  "guitar",
  "other",
];

export const STEM_DISPLAY_NAMES: Readonly<Record<StemType, string>> = {
  drums: "Drums",
  bass: "Bass",
  vocals: "Vocal",
  piano: "Piano",
  guitar: "Guitar",
  other: "Other",
};

export function stemTypesSupersededBy(type: StemType): ReadonlySet<StemType> {
  return new Set([type]);
}

export function stemTypeForTrack(track: ProjectTrack): StemType {
  if (track.kind === "drums") {
    return "drums";
  }
  if (BASS_INSTRUMENT_IDS.has(track.instrumentId)) {
    return "bass";
  }
  if (track.instrumentId === "voice") {
    return "vocals";
  }
  if (PIANO_INSTRUMENT_IDS.has(track.instrumentId)) {
    return "piano";
  }
  if (GUITAR_INSTRUMENT_IDS.has(track.instrumentId)) {
    return "guitar";
  }
  return "other";
}

export function comparisonTracks(
  tracks: readonly ProjectTrack[],
  stems: readonly ProjectStem[],
): ProjectTrack[] {
  const stemsByType = new Map(stems.map((stem) => [stem.type, stem]));
  const hasTrackSolo = tracks.some((track) => track.solo);
  return tracks.map((track) => ({
    ...track,
    mute:
      track.mute ||
      (stemsByType.get(stemTypeForTrack(track))?.mute ?? false),
    solo: hasTrackSolo
      ? track.solo
      : (stemsByType.get(stemTypeForTrack(track))?.solo ?? false),
  }));
}

export function comparisonStems(
  stems: readonly ProjectStem[],
  tracks: readonly ProjectTrack[],
): ProjectStem[] {
  const soloStemTypes = new Set(
    tracks.filter((track) => track.solo).map(stemTypeForTrack),
  );
  if (soloStemTypes.size === 0) {
    return [...stems];
  }
  return stems.map((stem) => ({
    ...stem,
    solo: soloStemTypes.has(stem.type),
  }));
}

export function playbackTracksForSource(
  source: PlaybackSource,
  tracks: readonly ProjectTrack[],
  groupedTracks: readonly ProjectTrack[],
  includeTranscriptionMix = false,
): ProjectTrack[] {
  if (source === "original" && !includeTranscriptionMix) {
    return tracks.map((track) => ({ ...track, mute: true, solo: false }));
  }
  return [...(source === "comparison" ? groupedTracks : tracks)];
}

export function playbackStemsForSource(
  source: PlaybackSource,
  stems: readonly ProjectStem[],
  groupedStems: readonly ProjectStem[],
  includeSourceMix = false,
): ProjectStem[] {
  if (source === "transcription" && !includeSourceMix) {
    return stems.map((stem) => ({ ...stem, mute: true, solo: false }));
  }
  return [...(source === "comparison" ? groupedStems : stems)];
}
