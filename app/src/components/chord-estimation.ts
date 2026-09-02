import type { ProjectNote, ProjectTrack } from "../types";

export interface EstimatedChordSpan {
  measureNumber: number;
  startBeat: number;
  beatLength: number;
  startSec: number;
  endSec: number;
  label: string;
}

interface ChordWindow {
  measureNumber: number;
  startBeat: number;
  beatLength: number;
  startSec: number;
  endSec: number;
  pitchClassDurations: number[];
  bassPitchClassDurations: number[];
  lowestPitchCandidates: Array<{
    startSec: number;
    endSec: number;
    pitch: number;
  }>;
}

interface PreparedChordEstimation {
  pitchedNotes: readonly ProjectNote[];
  trackById: ReadonlyMap<string, ProjectTrack>;
  explicitBassTrackIds: ReadonlySet<string>;
  windows: ChordWindow[];
}

export interface ChordEstimationProgress {
  completed: number;
  total: number;
}

export interface AsyncChordEstimationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ChordEstimationProgress) => void;
}

interface ChordTemplate {
  suffix: string;
  intervals: readonly number[];
  essentialIntervals: readonly number[];
  extensionInterval?: number;
  minimumExtensionSupportRatio?: number;
  complexityPenalty?: number;
}

interface WindowChordEstimate {
  label: string;
  root: number;
  chordPitchClasses: ReadonlySet<number>;
  score: number;
  coverage: number;
  strongToneCount: number;
  rootSupport: number;
}

const PITCH_CLASS_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

const CHORD_TEMPLATES: readonly ChordTemplate[] = [
  {
    suffix: "maj7",
    intervals: [0, 4, 7, 11],
    essentialIntervals: [0, 4, 11],
    extensionInterval: 11,
  },
  {
    suffix: "7",
    intervals: [0, 4, 7, 10],
    essentialIntervals: [0, 4, 10],
    extensionInterval: 10,
  },
  {
    suffix: "m7",
    intervals: [0, 3, 7, 10],
    essentialIntervals: [0, 3, 10],
    extensionInterval: 10,
  },
  {
    suffix: "m7b5",
    intervals: [0, 3, 6, 10],
    essentialIntervals: [0, 3, 6, 10],
    extensionInterval: 10,
  },
  {
    suffix: "6",
    intervals: [0, 4, 7, 9],
    essentialIntervals: [0, 4, 9],
    extensionInterval: 9,
  },
  {
    suffix: "m6",
    intervals: [0, 3, 7, 9],
    essentialIntervals: [0, 3, 9],
    extensionInterval: 9,
  },
  {
    suffix: "add9",
    intervals: [0, 2, 4, 7],
    essentialIntervals: [0, 2, 4],
    extensionInterval: 2,
    minimumExtensionSupportRatio: 0.5,
    complexityPenalty: 0.18,
  },
  {
    suffix: "madd9",
    intervals: [0, 2, 3, 7],
    essentialIntervals: [0, 2, 3],
    extensionInterval: 2,
    minimumExtensionSupportRatio: 0.5,
    complexityPenalty: 0.18,
  },
  {
    suffix: "7sus4",
    intervals: [0, 5, 7, 10],
    essentialIntervals: [0, 5, 10],
    extensionInterval: 10,
  },
  {
    suffix: "",
    intervals: [0, 4, 7],
    essentialIntervals: [0, 4],
  },
  {
    suffix: "m",
    intervals: [0, 3, 7],
    essentialIntervals: [0, 3],
  },
  {
    suffix: "dim",
    intervals: [0, 3, 6],
    essentialIntervals: [0, 3, 6],
  },
  {
    suffix: "aug",
    intervals: [0, 4, 8],
    essentialIntervals: [0, 4, 8],
  },
  {
    suffix: "sus2",
    intervals: [0, 2, 7],
    essentialIntervals: [0, 2, 7],
  },
  {
    suffix: "sus4",
    intervals: [0, 5, 7],
    essentialIntervals: [0, 5, 7],
  },
] as const;

const BASS_INSTRUMENT_IDS = new Set([
  "acoustic_bass",
  "electric_bass",
  "contrabass",
]);
const BASS_HARMONIC_WEIGHT = 0.45;
const VOCAL_HARMONIC_WEIGHT = 0.6;
const HARMONIC_PERSISTENCE_EXPONENT = 1.35;
const MIN_ESSENTIAL_SUPPORT_RATIO = 0.2;
const MIN_EXTENSION_SUPPORT_RATIO = 0.3;
const MIN_CHORD_COVERAGE = 0.5;
const MIN_LOCAL_CHANGE_COVERAGE = 0.62;
const MIN_LOCAL_CHANGE_TONES = 3;
const MIN_BAR_COMPATIBILITY_COVERAGE = 0.78;
const MIN_ROOT_CHANGE_SUPPORT = 0.48;
const MAX_SEQUENCE_CANDIDATES = 8;
const SEQUENCE_CANDIDATE_SCORE_MARGIN = 0.3;
const BASELINE_EMISSION_BONUS = 0.02;
const CHORD_CHANGE_PENALTY = 0.13;
const SAME_ROOT_CHANGE_PENALTY = 0.11;
const FIFTH_ROOT_CHANGE_PENALTY = 0.09;
const TIME_EPSILON_SEC = 1e-6;

function pitchClass(pitch: number): number {
  return ((pitch % 12) + 12) % 12;
}

function harmonicTrackWeight(track: ProjectTrack): number {
  if (BASS_INSTRUMENT_IDS.has(track.instrumentId)) {
    return BASS_HARMONIC_WEIGHT;
  }
  if (track.instrumentId === "voice") {
    return VOCAL_HARMONIC_WEIGHT;
  }
  return 1;
}

function saturatingPitchClassWeights(window: ChordWindow): number[] {
  const durationSec = Math.max(1e-6, window.endSec - window.startSec);
  // Sustained tones should dominate passing notes without octave doubling
  // increasing a pitch class without limit.
  return window.pitchClassDurations.map((duration) =>
    Math.pow(
      1 - Math.exp(-Math.max(0, duration) / durationSec),
      HARMONIC_PERSISTENCE_EXPONENT,
    ),
  );
}

function lowestPitchClassDurations(window: ChordWindow): number[] {
  const durations = Array.from({ length: 12 }, () => 0);
  const events = window.lowestPitchCandidates
    .flatMap((candidate) => [
      { timeSec: candidate.startSec, pitch: candidate.pitch, delta: 1 },
      { timeSec: candidate.endSec, pitch: candidate.pitch, delta: -1 },
    ])
    .sort(
      (left, right) =>
        left.timeSec - right.timeSec ||
        left.delta - right.delta ||
        left.pitch - right.pitch,
    );
  const activePitchCounts = new Map<number, number>();
  let cursorSec = window.startSec;
  let eventIndex = 0;
  while (eventIndex < events.length) {
    const eventTimeSec = events[eventIndex].timeSec;
    if (eventTimeSec > cursorSec && activePitchCounts.size > 0) {
      let lowestPitch = Number.POSITIVE_INFINITY;
      for (const pitch of activePitchCounts.keys()) {
        lowestPitch = Math.min(lowestPitch, pitch);
      }
      if (Number.isFinite(lowestPitch)) {
        durations[pitchClass(lowestPitch)] += eventTimeSec - cursorSec;
      }
    }
    cursorSec = eventTimeSec;
    while (
      eventIndex < events.length &&
      Math.abs(events[eventIndex].timeSec - eventTimeSec) <
        TIME_EPSILON_SEC
    ) {
      const event = events[eventIndex];
      const nextCount =
        (activePitchCounts.get(event.pitch) ?? 0) + event.delta;
      if (nextCount > 0) {
        activePitchCounts.set(event.pitch, nextCount);
      } else {
        activePitchCounts.delete(event.pitch);
      }
      eventIndex += 1;
    }
  }
  return durations;
}

function estimateWindowChordCandidates(
  window: ChordWindow,
): WindowChordEstimate[] {
  const weights = saturatingPitchClassWeights(window);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const maximumWeight = Math.max(...weights);
  if (totalWeight <= 0 || maximumWeight <= 0) {
    return [];
  }
  const strongToneThreshold =
    maximumWeight * MIN_ESSENTIAL_SUPPORT_RATIO;
  const bassTotal = window.bassPitchClassDurations.reduce(
    (sum, duration) => sum + duration,
    0,
  );
  const lowestDurations = lowestPitchClassDurations(window);
  const lowestTotal = lowestDurations.reduce(
    (sum, duration) => sum + duration,
    0,
  );
  const strongToneCount = weights.filter(
    (weight) => weight >= strongToneThreshold,
  ).length;
  const candidates: WindowChordEstimate[] = [];
  for (let root = 0; root < 12; root += 1) {
    for (const template of CHORD_TEMPLATES) {
      const chordPitchClasses = new Set(
        template.intervals.map((interval) => (root + interval) % 12),
      );
      const bassRootShare =
        bassTotal > 0
          ? window.bassPitchClassDurations[root] / bassTotal
          : 0;
      const lowestRootShare =
        lowestTotal > 0 ? lowestDurations[root] / lowestTotal : 0;
      const essentialSupported = template.essentialIntervals.every(
        (interval) => {
          const value = weights[(root + interval) % 12];
          const minimumSupport =
            interval === template.extensionInterval
              ? maximumWeight *
                (template.minimumExtensionSupportRatio ??
                  MIN_EXTENSION_SUPPORT_RATIO)
              : strongToneThreshold;
          return (
            value >= minimumSupport ||
            (interval === 0 && bassRootShare >= 0.22)
          );
        },
      );
      if (!essentialSupported) {
        continue;
      }
      const presentChordTones = [...chordPitchClasses].filter(
        (value) => weights[value] >= strongToneThreshold,
      ).length;
      if (
        presentChordTones < Math.min(3, template.intervals.length) &&
        !(presentChordTones >= 2 && bassRootShare >= 0.22)
      ) {
        continue;
      }
      const includedWeight = weights.reduce(
        (sum, weight, value) =>
          sum + (chordPitchClasses.has(value) ? weight : 0),
        0,
      );
      const coverage = includedWeight / totalWeight;
      if (coverage < MIN_CHORD_COVERAGE) {
        continue;
      }
      const outsideWeight = totalWeight - includedWeight;
      const completeness =
        presentChordTones / template.intervals.length;
      const essentialStrength =
        template.essentialIntervals.reduce(
          (sum, interval) =>
            sum + weights[(root + interval) % 12] / maximumWeight,
          0,
        ) / template.essentialIntervals.length;
      const bassChordCoverage =
        bassTotal > 0
          ? [...chordPitchClasses].reduce(
              (sum, value) =>
                sum + window.bassPitchClassDurations[value],
              0,
            ) / bassTotal
          : 0;
      const score =
        coverage * 2 -
        (outsideWeight / totalWeight) * 0.7 +
        completeness * 0.35 +
        essentialStrength * 0.25 +
        bassRootShare * 0.25 +
        lowestRootShare * 0.62 +
        bassChordCoverage * 0.08 -
        (template.complexityPenalty ??
          Math.max(0, template.intervals.length - 3) * 0.03);
      candidates.push({
        label: `${PITCH_CLASS_NAMES[root]}${template.suffix}`,
        root,
        chordPitchClasses,
        score,
        coverage,
        strongToneCount,
        rootSupport: Math.max(bassRootShare, lowestRootShare),
      });
    }
  }
  return candidates.sort((left, right) => right.score - left.score);
}

function estimateWindowChordCandidate(
  window: ChordWindow,
): WindowChordEstimate | null {
  return estimateWindowChordCandidates(window)[0] ?? null;
}

function prepareChordEstimation(
  notes: readonly ProjectNote[],
  tracks: readonly ProjectTrack[],
  bpm: number,
  beatOffsetSec: number,
  numerator: number,
  denominator: number,
): PreparedChordEstimation | null {
  if (
    !Number.isFinite(bpm) ||
    bpm <= 0 ||
    !Number.isFinite(beatOffsetSec) ||
    beatOffsetSec < 0 ||
    numerator < 1 ||
    denominator < 1
  ) {
    return null;
  }
  const pitchedTrackIds = new Set(
    tracks.filter((track) => track.kind === "pitched").map((track) => track.id),
  );
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const explicitBassTrackIds = new Set(
    tracks
      .filter(
        (track) =>
          track.kind === "pitched" &&
          BASS_INSTRUMENT_IDS.has(track.instrumentId),
      )
      .map((track) => track.id),
  );
  const pitchedNotes = notes.filter(
    (note) =>
      pitchedTrackIds.has(note.trackId) &&
      note.endSec > beatOffsetSec &&
      note.endSec > note.startSec,
  );
  if (pitchedNotes.length === 0) {
    return null;
  }

  const beatDurationSec = (60 / bpm) * (4 / denominator);
  const segmentBeats = Math.min(2, numerator);
  let lastEndSec = beatOffsetSec;
  for (const note of pitchedNotes) {
    lastEndSec = Math.max(lastEndSec, note.endSec);
  }
  const measureDurationSec = beatDurationSec * numerator;
  const measureCount = Math.max(
    1,
    Math.ceil((lastEndSec - beatOffsetSec) / measureDurationSec),
  );
  const windows: ChordWindow[] = [];
  for (let measureIndex = 0; measureIndex < measureCount; measureIndex += 1) {
    for (
      let beatIndex = 0;
      beatIndex < numerator;
      beatIndex += segmentBeats
    ) {
      const beatLength = Math.min(segmentBeats, numerator - beatIndex);
      const startSec =
        beatOffsetSec +
        (measureIndex * numerator + beatIndex) * beatDurationSec;
      windows.push({
        measureNumber: measureIndex + 1,
        startBeat: beatIndex + 1,
        beatLength,
        startSec,
        endSec: startSec + beatLength * beatDurationSec,
        pitchClassDurations: Array.from({ length: 12 }, () => 0),
        bassPitchClassDurations: Array.from({ length: 12 }, () => 0),
        lowestPitchCandidates: [],
      });
    }
  }
  return {
    pitchedNotes,
    trackById,
    explicitBassTrackIds,
    windows,
  };
}

function firstWindowEndingAfter(
  windows: readonly ChordWindow[],
  timeSec: number,
): number {
  let low = 0;
  let high = windows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (windows[middle].endSec <= timeSec) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function accumulateNote(
  prepared: PreparedChordEstimation,
  note: ProjectNote,
  beatOffsetSec: number,
): void {
  const track = prepared.trackById.get(note.trackId);
  if (track === undefined) {
    return;
  }
  const noteStart = Math.max(note.startSec, beatOffsetSec);
  const noteEnd = note.endSec;
  const velocityWeight = 0.5 + Math.min(127, Math.max(1, note.velocity)) / 254;
  const trackWeight = harmonicTrackWeight(track);
  for (
    let windowIndex = firstWindowEndingAfter(prepared.windows, noteStart);
    windowIndex < prepared.windows.length;
    windowIndex += 1
  ) {
    const window = prepared.windows[windowIndex];
    if (window.startSec >= noteEnd) {
      break;
    }
    const overlapSec =
      Math.min(noteEnd, window.endSec) - Math.max(noteStart, window.startSec);
    if (overlapSec <= 0) {
      continue;
    }
    const notePitchClass = pitchClass(note.pitch);
    window.pitchClassDurations[notePitchClass] +=
      overlapSec * velocityWeight * trackWeight;
    if (prepared.explicitBassTrackIds.has(note.trackId)) {
      window.bassPitchClassDurations[notePitchClass] +=
        overlapSec * velocityWeight;
    } else if (
      prepared.explicitBassTrackIds.size === 0 &&
      note.pitch <= 60
    ) {
      const lowRegisterWeight = Math.min(
        4,
        2 ** ((60 - note.pitch) / 12),
      );
      window.bassPitchClassDurations[notePitchClass] +=
        overlapSec * velocityWeight * lowRegisterWeight;
    }
    const isLowestPitchCandidate =
      prepared.explicitBassTrackIds.size > 0
        ? prepared.explicitBassTrackIds.has(note.trackId)
        : note.pitch <= 60;
    if (isLowestPitchCandidate) {
      window.lowestPitchCandidates.push({
        startSec: Math.max(noteStart, window.startSec),
        endSec: Math.min(noteEnd, window.endSec),
        pitch: note.pitch,
      });
    }
  }
}

function aggregateMeasureWindows(windows: readonly ChordWindow[]): ChordWindow {
  const first = windows[0];
  const last = windows.at(-1) ?? first;
  const aggregate: ChordWindow = {
    measureNumber: first.measureNumber,
    startBeat: first.startBeat,
    beatLength: windows.reduce(
      (sum, window) => sum + window.beatLength,
      0,
    ),
    startSec: first.startSec,
    endSec: last.endSec,
    pitchClassDurations: Array.from({ length: 12 }, () => 0),
    bassPitchClassDurations: Array.from({ length: 12 }, () => 0),
    lowestPitchCandidates: [],
  };
  for (const window of windows) {
    for (let pitchClassIndex = 0; pitchClassIndex < 12; pitchClassIndex += 1) {
      aggregate.pitchClassDurations[pitchClassIndex] +=
        window.pitchClassDurations[pitchClassIndex];
      aggregate.bassPitchClassDurations[pitchClassIndex] +=
        window.bassPitchClassDurations[pitchClassIndex];
    }
    aggregate.lowestPitchCandidates.push(...window.lowestPitchCandidates);
  }
  return aggregate;
}

function chordCoverage(
  window: ChordWindow,
  chord: WindowChordEstimate,
): number {
  const weights = saturatingPitchClassWeights(window);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return 0;
  }
  const includedWeight = weights.reduce(
    (sum, weight, value) =>
      sum + (chord.chordPitchClasses.has(value) ? weight : 0),
    0,
  );
  return includedWeight / totalWeight;
}

function chordTransitionScore(
  previous: WindowChordEstimate,
  current: WindowChordEstimate,
): number {
  if (previous.label === current.label) {
    return 0;
  }
  const rootInterval = (current.root - previous.root + 12) % 12;
  let penalty = CHORD_CHANGE_PENALTY;
  if (rootInterval === 0) {
    penalty = SAME_ROOT_CHANGE_PENALTY;
  } else if (rootInterval === 5 || rootInterval === 7) {
    penalty = FIFTH_ROOT_CHANGE_PENALTY;
  }
  const hasStrongChangeEvidence =
    current.rootSupport >= MIN_ROOT_CHANGE_SUPPORT &&
    current.coverage >= MIN_LOCAL_CHANGE_COVERAGE &&
    current.strongToneCount >= MIN_LOCAL_CHANGE_TONES;
  return -(hasStrongChangeEvidence ? penalty * 0.15 : penalty);
}

function sequenceCandidates(
  window: ChordWindow,
  baselineLabel: string | null,
): WindowChordEstimate[] | null {
  if (baselineLabel === null) {
    return null;
  }
  const candidates = estimateWindowChordCandidates(window);
  const best = candidates[0];
  const baseline = candidates.find(
    (candidate) => candidate.label === baselineLabel,
  );
  if (best === undefined || baseline === undefined) {
    return null;
  }
  const selected = candidates
    .filter(
      (candidate) =>
        candidate.score >= best.score - SEQUENCE_CANDIDATE_SCORE_MARGIN,
    )
    .slice(0, MAX_SEQUENCE_CANDIDATES);
  if (!selected.includes(baseline)) {
    selected.push(baseline);
  }
  return selected;
}

function sequenceEmissionScore(
  candidate: WindowChordEstimate,
  candidates: readonly WindowChordEstimate[],
  baselineLabel: string | null,
): number {
  if (candidate.label === baselineLabel) {
    return BASELINE_EMISSION_BONUS;
  }
  return candidate.score - candidates[0].score;
}

function optimizeChordSequence(
  candidateRows: readonly WindowChordEstimate[][],
  baselineLabels: readonly (string | null)[],
): string[] {
  let previousScores = candidateRows[0].map((candidate) =>
    sequenceEmissionScore(candidate, candidateRows[0], baselineLabels[0]),
  );
  const backPointers: number[][] = [
    candidateRows[0].map(() => -1),
  ];
  for (let rowIndex = 1; rowIndex < candidateRows.length; rowIndex += 1) {
    const previousRow = candidateRows[rowIndex - 1];
    const currentRow = candidateRows[rowIndex];
    const currentScores = currentRow.map((currentCandidate) => {
      let bestPreviousIndex = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (
        let previousIndex = 0;
        previousIndex < previousRow.length;
        previousIndex += 1
      ) {
        const score =
          previousScores[previousIndex] +
          chordTransitionScore(
            previousRow[previousIndex],
            currentCandidate,
          );
        if (score > bestScore) {
          bestScore = score;
          bestPreviousIndex = previousIndex;
        }
      }
      backPointers[rowIndex] ??= [];
      backPointers[rowIndex].push(bestPreviousIndex);
      return (
        bestScore +
        sequenceEmissionScore(
          currentCandidate,
          currentRow,
          baselineLabels[rowIndex],
        )
      );
    });
    previousScores = currentScores;
  }

  let candidateIndex = previousScores.reduce(
    (bestIndex, score, index) =>
      score > previousScores[bestIndex] ? index : bestIndex,
    0,
  );
  const labels = new Array<string>(candidateRows.length);
  for (
    let rowIndex = candidateRows.length - 1;
    rowIndex >= 0;
    rowIndex -= 1
  ) {
    labels[rowIndex] = candidateRows[rowIndex][candidateIndex].label;
    candidateIndex = backPointers[rowIndex][candidateIndex];
  }
  return labels;
}

function stabilizeChordSequence(
  windows: readonly ChordWindow[],
  labels: readonly (string | null)[],
): Array<string | null> {
  const stabilized = [...labels];
  const rows = windows.map((window, index) =>
    sequenceCandidates(window, labels[index]),
  );
  let runStart = 0;
  while (runStart < rows.length) {
    while (runStart < rows.length && rows[runStart] === null) {
      runStart += 1;
    }
    let runEnd = runStart;
    while (runEnd < rows.length && rows[runEnd] !== null) {
      runEnd += 1;
    }
    if (runEnd - runStart >= 2) {
      const candidateRows = rows.slice(
        runStart,
        runEnd,
      ) as WindowChordEstimate[][];
      const optimized = optimizeChordSequence(
        candidateRows,
        labels.slice(runStart, runEnd),
      );
      for (let index = 0; index < optimized.length; index += 1) {
        stabilized[runStart + index] = optimized[index];
      }
    }
    runStart = Math.max(runEnd, runStart + 1);
  }
  return stabilized;
}

function resolveWindowChordLabels(
  windows: readonly ChordWindow[],
): Array<string | null> {
  const labels = new Array<string | null>(windows.length).fill(null);
  let firstWindowIndex = 0;
  while (firstWindowIndex < windows.length) {
    const measureNumber = windows[firstWindowIndex].measureNumber;
    let endWindowIndex = firstWindowIndex + 1;
    while (
      endWindowIndex < windows.length &&
      windows[endWindowIndex].measureNumber === measureNumber
    ) {
      endWindowIndex += 1;
    }
    const measureWindows = windows.slice(
      firstWindowIndex,
      endWindowIndex,
    );
    const localEstimates = measureWindows.map(
      estimateWindowChordCandidate,
    );
    const measureEstimate = estimateWindowChordCandidate(
      aggregateMeasureWindows(measureWindows),
    );
    const localLabels = localEstimates
      .filter((estimate) => estimate !== null)
      .map((estimate) => estimate.label);
    const hasDistinctLocalChords = new Set(localLabels).size > 1;
    const hasIndependentLocalEvidence = localEstimates.every(
      (estimate) =>
        estimate !== null &&
        estimate.coverage >= MIN_LOCAL_CHANGE_COVERAGE &&
        estimate.strongToneCount >= MIN_LOCAL_CHANGE_TONES,
    );
    const measureExplainsEveryWindow =
      measureEstimate !== null &&
      measureWindows.every(
        (window) =>
          chordCoverage(window, measureEstimate) >=
          MIN_BAR_COMPATIBILITY_COVERAGE,
      );
    const localRoots = new Set(
      localEstimates
        .filter((estimate) => estimate !== null)
        .map((estimate) => estimate.root),
    );
    const hasSupportedRootChange =
      localRoots.size > 1 &&
      localEstimates.every(
        (estimate) =>
          estimate !== null &&
          estimate.rootSupport >= MIN_ROOT_CHANGE_SUPPORT,
      );
    const preserveLocalChanges =
      hasDistinctLocalChords &&
      hasIndependentLocalEvidence &&
      (hasSupportedRootChange || !measureExplainsEveryWindow);

    for (
      let windowIndex = firstWindowIndex;
      windowIndex < endWindowIndex;
      windowIndex += 1
    ) {
      const localEstimate =
        localEstimates[windowIndex - firstWindowIndex];
      const localWindow = windows[windowIndex];
      const hasHarmonicEvidence = localWindow.pitchClassDurations.some(
        (duration) => duration > 0,
      );
      labels[windowIndex] =
        hasHarmonicEvidence &&
        measureEstimate !== null &&
        !preserveLocalChanges
          ? measureEstimate.label
          : localEstimate?.label ?? null;
    }
    firstWindowIndex = endWindowIndex;
  }
  return stabilizeChordSequence(windows, labels);
}

function appendEstimatedChord(
  spans: EstimatedChordSpan[],
  window: ChordWindow,
  label: string | null,
): void {
  if (label === null) {
    return;
  }
  const previous = spans.at(-1);
  if (
    previous !== undefined &&
    previous.measureNumber === window.measureNumber &&
    previous.label === label &&
    Math.abs(previous.endSec - window.startSec) < 1e-6
  ) {
    previous.beatLength += window.beatLength;
    previous.endSec = window.endSec;
    return;
  }
  spans.push({
    measureNumber: window.measureNumber,
    startBeat: window.startBeat,
    beatLength: window.beatLength,
    startSec: window.startSec,
    endSec: window.endSec,
    label,
  });
}

export function estimateChordSpans(
  notes: readonly ProjectNote[],
  tracks: readonly ProjectTrack[],
  bpm: number,
  beatOffsetSec: number,
  numerator: number,
  denominator: number,
): EstimatedChordSpan[] {
  const prepared = prepareChordEstimation(
    notes,
    tracks,
    bpm,
    beatOffsetSec,
    numerator,
    denominator,
  );
  if (prepared === null) {
    return [];
  }
  for (const note of prepared.pitchedNotes) {
    accumulateNote(prepared, note, beatOffsetSec);
  }
  const labels = resolveWindowChordLabels(prepared.windows);
  const spans: EstimatedChordSpan[] = [];
  for (
    let windowIndex = 0;
    windowIndex < prepared.windows.length;
    windowIndex += 1
  ) {
    appendEstimatedChord(
      spans,
      prepared.windows[windowIndex],
      labels[windowIndex],
    );
  }
  return spans;
}

function yieldToRenderer(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("コード解析を中止しました", "AbortError");
  }
}

export async function estimateChordSpansAsync(
  notes: readonly ProjectNote[],
  tracks: readonly ProjectTrack[],
  bpm: number,
  beatOffsetSec: number,
  numerator: number,
  denominator: number,
  options: AsyncChordEstimationOptions = {},
): Promise<EstimatedChordSpan[]> {
  const prepared = prepareChordEstimation(
    notes,
    tracks,
    bpm,
    beatOffsetSec,
    numerator,
    denominator,
  );
  if (prepared === null) {
    options.onProgress?.({ completed: 1, total: 1 });
    return [];
  }

  const total = prepared.pitchedNotes.length + prepared.windows.length;
  let completed = 0;
  options.onProgress?.({ completed, total });
  await yieldToRenderer();

  for (const note of prepared.pitchedNotes) {
    throwIfAborted(options.signal);
    accumulateNote(prepared, note, beatOffsetSec);
    completed += 1;
    if (completed % 128 === 0 || completed === prepared.pitchedNotes.length) {
      options.onProgress?.({ completed, total });
      await yieldToRenderer();
    }
  }

  const labels = resolveWindowChordLabels(prepared.windows);
  const spans: EstimatedChordSpan[] = [];
  for (
    let windowIndex = 0;
    windowIndex < prepared.windows.length;
    windowIndex += 1
  ) {
    throwIfAborted(options.signal);
    appendEstimatedChord(
      spans,
      prepared.windows[windowIndex],
      labels[windowIndex],
    );
    completed += 1;
    if (completed % 16 === 0 || completed === total) {
      options.onProgress?.({ completed, total });
      await yieldToRenderer();
    }
  }
  throwIfAborted(options.signal);
  return spans;
}
