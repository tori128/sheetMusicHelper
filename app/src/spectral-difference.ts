import { BasicMIDI, MIDIBuilder } from "spessasynth_core";
import {
  WorkletSynthesizer,
  audioBufferToWav,
} from "spessasynth_lib";
import workletUrl from "spessasynth_lib/dist/spessasynth_processor.min.js?url";
import {
  STEM_DISPLAY_NAMES,
  STEM_DISPLAY_ORDER,
  stemTypeForTrack,
} from "./stem-playback";
import { resolveNoteOverlaps } from "./store/project-editing";
import { trackMidiVolume } from "./track-playback-volume";
import type {
  ProjectDocument,
  ProjectNote,
  ProjectStem,
  ProjectTrack,
  StemType,
} from "./types";

export const SPECTRAL_DIFFERENCE_SAMPLE_RATE = 22_050;
export const SPECTRAL_DIFFERENCE_MAXIMUM_DURATION_SEC = 900;
const PPQ = 480;
const RELEASE_TAIL_SEC = 0.5;

export interface SpectralDifferenceInterval {
  startSec: number;
  endSec: number;
  measureNumber: number;
  beatInMeasure: number;
  value: number;
}

export interface SpectralDifferenceResult {
  intervals: SpectralDifferenceInterval[];
  minimum: number;
  maximum: number;
}

export interface SpectralDifferenceRequest {
  sourcePaths: string[];
  synthesizedPath: string;
  durationSec: number;
  timelineOffsetSec: number;
  bpm: number;
  beatOffsetSec: number;
  numerator: number;
  denominator: number;
}

export interface SpectralComparisonSelection {
  tracks: ProjectTrack[];
  notes: ProjectNote[];
  sourcePaths: string[];
  sourceHashes: string[];
  label: string;
}

function playbackPitch(track: ProjectTrack, pitch: number): number {
  if (track.kind !== "pitched") {
    return pitch;
  }
  return Math.max(
    0,
    Math.min(127, pitch + track.playbackOctaveShift * 12),
  );
}

function selectedStemTypes(
  tracks: readonly ProjectTrack[],
  stems: readonly ProjectStem[],
): StemType[] {
  const selected = new Set<StemType>(
    stems.filter((stem) => stem.solo).map((stem) => stem.type),
  );
  for (const track of tracks.filter((track) => track.solo)) {
    selected.add(stemTypeForTrack(track));
  }
  return STEM_DISPLAY_ORDER.filter((type) => selected.has(type));
}

export function selectSpectralComparison(
  project: ProjectDocument,
): SpectralComparisonSelection {
  const stemTypes = selectedStemTypes(project.tracks, project.stems);
  if (stemTypes.length === 0) {
    return {
      tracks: [...project.tracks],
      notes: [...project.notes],
      sourcePaths: [project.sourceAudio.absolutePath],
      sourceHashes: [project.sourceAudio.sha256],
      label: "全パート",
    };
  }

  const stemByType = new Map(project.stems.map((stem) => [stem.type, stem]));
  const missing = stemTypes.filter((type) => !stemByType.has(type));
  if (missing.length > 0) {
    throw new Error(
      `${missing.map((type) => STEM_DISPLAY_NAMES[type]).join("／")}の分離音源がありません`,
    );
  }
  const includedTypes = new Set(stemTypes);
  const tracks = project.tracks.filter((track) =>
    includedTypes.has(stemTypeForTrack(track)),
  );
  const trackIds = new Set(tracks.map((track) => track.id));
  const stems = stemTypes.map(
    (type) => stemByType.get(type) as ProjectStem,
  );
  return {
    tracks,
    notes: project.notes.filter((note) => trackIds.has(note.trackId)),
    sourcePaths: stems.map((stem) => stem.cachePath),
    sourceHashes: stems.map((stem) => stem.sha256),
    label: stemTypes.map((type) => STEM_DISPLAY_NAMES[type]).join("＋"),
  };
}

export function spectralComparisonKey(
  project: ProjectDocument,
  selection: SpectralComparisonSelection,
): string {
  return JSON.stringify({
    sourceHashes: selection.sourceHashes,
    durationSec: project.sourceAudio.durationSec,
    timelineOffsetSec: project.sourceAudio.timelineOffsetSec,
    bpm: project.tempo.bpm,
    beatOffsetSec: project.tempo.beatOffsetSec,
    timeSignature: project.tempo.timeSignature,
    tracks: selection.tracks.map((track) => ({
      id: track.id,
      midiChannel: track.midiChannel,
      gmProgram: track.gmProgram,
      playbackOctaveShift: track.playbackOctaveShift,
      playbackVolume: track.playbackVolume,
    })),
    notes: selection.notes.map((note) => ({
      id: note.id,
      trackId: note.trackId,
      pitch: note.pitch,
      startSec: note.startSec,
      endSec: note.endSec,
      velocity: note.velocity,
    })),
  });
}

export function buildSpectralComparisonMidi(
  tracks: readonly ProjectTrack[],
  notes: readonly ProjectNote[],
  bpm: number,
): BasicMIDI {
  const midi = new MIDIBuilder({
    timeDivision: PPQ,
    initialTempo: bpm,
    format: 1,
    name: "EarCopy Assist spectral comparison",
  });
  const trackNumberById = new Map<string, number>();
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  for (const track of tracks) {
    midi.addTrack(track.displayName);
    const trackNumber = midi.tracks.length - 1;
    const channel = track.midiChannel - 1;
    trackNumberById.set(track.id, trackNumber);
    if (track.kind === "pitched" && track.gmProgram !== null) {
      midi.programChange(0, trackNumber, channel, track.gmProgram);
    }
    const volume = trackMidiVolume(track);
    midi.controllerChange(
      0,
      trackNumber,
      channel,
      volume.controller,
      volume.value,
    );
    midi.controllerChange(0, trackNumber, channel, 91, 0);
    midi.controllerChange(0, trackNumber, channel, 93, 0);
    midi.controllerChange(0, trackNumber, channel, 94, 0);
  }
  const ticksPerSecond = (PPQ * bpm) / 60;
  for (const note of resolveNoteOverlaps([...notes])) {
    const track = trackById.get(note.trackId);
    const trackNumber = trackNumberById.get(note.trackId);
    if (track === undefined || trackNumber === undefined || note.endSec <= 0) {
      continue;
    }
    const startTick = Math.max(0, Math.round(note.startSec * ticksPerSecond));
    const endTick = Math.max(
      startTick + 1,
      Math.round(note.endSec * ticksPerSecond),
    );
    const channel = track.midiChannel - 1;
    const pitch = playbackPitch(track, note.pitch);
    midi.noteOn(
      startTick,
      trackNumber,
      channel,
      pitch,
      note.velocity,
    );
    midi.noteOff(endTick, trackNumber, channel, pitch);
  }
  midi.flush(true);
  return BasicMIDI.copyFrom(midi);
}

export async function renderSpectralComparisonWav(
  soundFontBytes: Uint8Array,
  tracks: readonly ProjectTrack[],
  notes: readonly ProjectNote[],
  bpm: number,
  durationSec: number,
): Promise<Uint8Array> {
  if (durationSec <= 0 || durationSec > SPECTRAL_DIFFERENCE_MAXIMUM_DURATION_SEC) {
    throw new Error(
      `原音との差は${SPECTRAL_DIFFERENCE_MAXIMUM_DURATION_SEC / 60}分以下の音源で計算できます`,
    );
  }
  if (soundFontBytes.byteLength === 0) {
    throw new Error("SoundFontを読み込み中です");
  }
  const renderDurationSec = durationSec + RELEASE_TAIL_SEC;
  const context = new OfflineAudioContext(
    2,
    Math.ceil(renderDurationSec * SPECTRAL_DIFFERENCE_SAMPLE_RATE),
    SPECTRAL_DIFFERENCE_SAMPLE_RATE,
  );
  await context.audioWorklet.addModule(workletUrl);
  const synth = new WorkletSynthesizer(context, { eventsEnabled: false });
  synth.connect(context.destination);
  const soundBankBuffer = soundFontBytes.buffer.slice(
    soundFontBytes.byteOffset,
    soundFontBytes.byteOffset + soundFontBytes.byteLength,
  ) as ArrayBuffer;
  try {
    await synth.startOfflineRender({
      midiSequence: buildSpectralComparisonMidi(tracks, notes, bpm),
      loopCount: 0,
      soundBankList: [{ bankOffset: 0, soundBankBuffer }],
      sequencerOptions: {
        skipToFirstNoteOn: false,
        initialPlaybackRate: 1,
      },
    });
    const rendered = await context.startRendering();
    const wav = audioBufferToWav(rendered, { normalizeAudio: false });
    return new Uint8Array(await wav.arrayBuffer());
  } finally {
    synth.destroy();
  }
}

export function spectralDifferenceColor(differenceValue: number): string {
  const value = Math.max(0, Math.min(1, differenceValue));
  const low = [55, 166, 116];
  const middle = [224, 168, 46];
  const high = [214, 75, 75];
  const [from, to, ratio] = value <= 0.5
    ? [low, middle, value * 2]
    : [middle, high, (value - 0.5) * 2];
  const color = from.map((channel, index) =>
    Math.round(channel + (to[index] - channel) * ratio)
      .toString(16)
      .padStart(2, "0")
  );
  return `#${color.join("")}`;
}

export function normalizeSpectralDifferenceForDisplay(
  differenceValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = Math.max(0, Math.min(1, differenceValue));
  const range = maximum - minimum;
  if (range <= Number.EPSILON) {
    return value;
  }
  return Math.max(0, Math.min(1, (value - minimum) / range));
}
