import { describe, expect, it } from "vitest";
import { WorkletSynthesizer } from "spessasynth_lib";
import {
  buildSpectralComparisonMidi,
  normalizeSpectralDifferenceForDisplay,
  selectSpectralComparison,
  spectralComparisonKey,
  spectralDifferenceColor,
} from "./spectral-difference";
import type {
  ProjectDocument,
  ProjectNote,
  ProjectStem,
  ProjectTrack,
  StemType,
} from "./types";

function track(
  id: string,
  instrumentId: string,
  solo = false,
): ProjectTrack {
  return {
    id,
    displayName: id,
    instrumentId,
    kind: instrumentId === "drums" ? "drums" : "pitched",
    color: "#4488cc",
    order: 0,
    midiChannel: instrumentId === "drums" ? 10 : 1,
    gmProgram: instrumentId === "drums" ? null : 0,
    playbackOctaveShift: 0,
    playbackVolume: 100,
    mute: false,
    solo,
  };
}

function stem(type: StemType, solo = false): ProjectStem {
  return {
    type,
    cachePath: `D:\\cache\\${type}.wav`,
    sha256: `${type}-hash`,
    sampleRate: 44100,
    channels: 2,
    mute: false,
    solo,
  };
}

function note(id: string, trackId: string): ProjectNote {
  return {
    id,
    sourceInstrumentId: "acoustic_piano",
    trackId,
    pitch: 60,
    rawStartSec: 0,
    rawEndSec: 1,
    startSec: 0,
    endSec: 1,
    velocity: 100,
  };
}

function project(): ProjectDocument {
  const tracks = [
    track("piano", "acoustic_piano"),
    track("acoustic-guitar", "acoustic_guitar"),
    track("electric-guitar", "distorted_electric_guitar"),
    track("bass", "electric_bass"),
  ];
  return {
    formatVersion: 5,
    appVersion: "test",
    projectId: "project",
    name: "song",
    sourceAudio: {
      absolutePath: "D:\\audio\\song.wav",
      relativePath: "song.wav",
      sha256: "source-hash",
      durationSec: 10,
      sampleRate: 48000,
      channels: 2,
      timelineOffsetSec: 0,
    },
    tempo: {
      bpm: 120,
      beatOffsetSec: 0,
      timeSignature: { numerator: 4, denominator: 4 },
      ppq: 480,
      quantizeGrid: "1/16",
    },
    transcription: null,
    tracks,
    notes: tracks.map((candidate) => note(`note-${candidate.id}`, candidate.id)),
    stems: [
      stem("piano"),
      stem("guitar"),
      stem("bass"),
      stem("other"),
    ],
    score: {
      composer: "",
      arranger: "",
      copyright: "",
      keyFifths: 0,
      keyMode: "major",
      pickupTicks: 0,
      includeChordSymbols: true,
      chords: [],
      trackSettings: {},
    },
    viewState: {
      activeRoll: "pitched",
      horizontalZoom: 1,
      verticalZoom: 1,
      scrollTimeSec: 0,
    },
  };
}

describe("spectral comparison selection", () => {
  it("compares every track with the original audio when no Solo is active", () => {
    const source = project();

    const selection = selectSpectralComparison(source);

    expect(selection.tracks).toHaveLength(4);
    expect(selection.notes).toHaveLength(4);
    expect(selection.sourcePaths).toEqual([source.sourceAudio.absolutePath]);
    expect(selection.label).toBe("全パート");
  });

  it("compares every guitar track with the guitar stem for Guitar Solo", () => {
    const source = project();
    source.tracks[1].solo = true;

    const selection = selectSpectralComparison(source);

    expect(selection.tracks.map(({ id }) => id)).toEqual([
      "acoustic-guitar",
      "electric-guitar",
    ]);
    expect(selection.notes).toHaveLength(2);
    expect(selection.sourcePaths).toEqual(["D:\\cache\\guitar.wav"]);
    expect(selection.label).toBe("Guitar");
  });

  it("uses a separated stem Solo as the comparison target", () => {
    const source = project();
    const bassStem = source.stems.find(({ type }) => type === "bass")!;
    bassStem.solo = true;

    const selection = selectSpectralComparison(source);

    expect(selection.tracks.map(({ id }) => id)).toEqual(["bass"]);
    expect(selection.sourcePaths).toEqual([bassStem.cachePath]);
  });

  it("rejects a Solo target without a separated source", () => {
    const source = project();
    source.tracks[0].solo = true;
    source.stems = source.stems.filter(({ type }) => type !== "piano");

    expect(() => selectSpectralComparison(source)).toThrow(
      "Pianoの分離音源がありません",
    );
  });

  it("changes the result key after a note edit", () => {
    const source = project();
    const before = selectSpectralComparison(source);
    const beforeKey = spectralComparisonKey(source, before);
    source.notes[0].pitch += 1;

    expect(
      spectralComparisonKey(source, selectSpectralComparison(source)),
    ).not.toBe(beforeKey);
  });

  it("changes the result key after a playback volume change", () => {
    const source = project();
    const beforeKey = spectralComparisonKey(
      source,
      selectSpectralComparison(source),
    );
    source.tracks[0].playbackVolume = 40;

    expect(
      spectralComparisonKey(source, selectSpectralComparison(source)),
    ).not.toBe(beforeKey);
  });
});

it("builds a format 1 MIDI sequence for multiple transcription tracks", () => {
  const tracks = [
    track("piano", "acoustic_piano"),
    track("guitar", "acoustic_guitar"),
  ];
  const notes = tracks.map((candidate) =>
    note(`note-${candidate.id}`, candidate.id)
  );

  const midi = buildSpectralComparisonMidi(tracks, notes, 120);

  expect(midi.format).toBe(1);
  expect(midi.tracks).toHaveLength(3);
});

it("passes the comparison MIDI through the offline-render MessagePort", async () => {
  const tracks = [track("piano", "acoustic_piano")];
  const midiSequence = buildSpectralComparisonMidi(
    tracks,
    [note("note-piano", "piano")],
    120,
  );
  const port: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage(data: unknown, transfer?: Transferable[]): void;
  } = {
    onmessage: null,
    postMessage(data, transfer = []) {
      structuredClone(data, { transfer });
      if (
        typeof data === "object" &&
        data !== null &&
        "type" in data &&
        data.type === "startOfflineRender"
      ) {
        queueMicrotask(() =>
          port.onmessage?.({
            data: {
              type: "isFullyInitialized",
              data: { type: "startOfflineRender", data: null },
            },
          } as MessageEvent),
        );
      }
    },
  };
  const worklet = {
    context: { currentTime: 0 },
    port,
    connect() {},
    disconnect() {},
  } as unknown as AudioWorkletNode;
  const synth = new WorkletSynthesizer({} as BaseAudioContext, {
    eventsEnabled: false,
    audioNodeCreators: {
      worklet: () => worklet,
    },
  });

  await expect(
    synth.startOfflineRender({
      midiSequence,
      loopCount: 0,
      soundBankList: [
        { bankOffset: 0, soundBankBuffer: new ArrayBuffer(1) },
      ],
    }),
  ).resolves.toBeUndefined();
  synth.destroy();
});

it("maps absolute difference values from green through amber to red", () => {
  expect(spectralDifferenceColor(0)).toBe("#37a674");
  expect(spectralDifferenceColor(0.001)).toBe("#37a674");
  expect(spectralDifferenceColor(0.5)).toBe("#e0a82e");
  expect(spectralDifferenceColor(1)).toBe("#d64b4b");
});

it("normalizes difference colors across the complete song", () => {
  expect(normalizeSpectralDifferenceForDisplay(0.2, 0.2, 0.8)).toBe(0);
  expect(normalizeSpectralDifferenceForDisplay(0.5, 0.2, 0.8))
    .toBeCloseTo(0.5, 10);
  expect(normalizeSpectralDifferenceForDisplay(0.8, 0.2, 0.8)).toBe(1);
  expect(normalizeSpectralDifferenceForDisplay(0.4, 0.4, 0.4)).toBe(0.4);
});
