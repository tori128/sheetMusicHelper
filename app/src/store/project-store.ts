import type {
  AudioInfo,
  SeparatedTranscriptionSettings,
  InstrumentDefinition,
  InstrumentSelectionMode,
  InferenceBackend,
  JobNoteEvent,
  ModelProfile,
  PresetDefinition,
  ProjectDocument,
  ProjectNote,
  ProjectTranscriptionInputResult,
  QuantizeGrid,
  ScoreSettings,
  StemType,
  TranscriptionProfile,
  TranscriptionJobEvent,
  TranscriptionJobStatus,
} from "../types";
import {
  DEFAULT_TRACK_PLAYBACK_VOLUME,
  MAX_TRACK_PLAYBACK_VOLUME,
  MIN_TRACK_PLAYBACK_VOLUME,
} from "../track-playback-volume";
import {
  addStemToPlaybackControlState,
  addTrackToPlaybackControlState,
  resetPlaybackControlState,
  toggleStemMuteState,
  toggleStemSoloState,
  toggleTrackMuteState,
  toggleTrackSoloState,
  type PlaybackControlState,
} from "../playback-control-state";
import type { PlaybackSource } from "../soundfont-playback";
import {
  stemTypeForTrack,
  stemTypesSupersededBy,
} from "../stem-playback";
import {
  postTranscriptionOptionStemTypes,
  type PostTranscriptionOptionKey,
} from "../transcription-option-settings";
import {
  transcriptionPassCompletion,
  transcriptionPassProgressDetail,
} from "../transcription-progress";
import {
  deleteNotes,
  moveSelectedNotesOnPianoRoll as moveNotesOnPianoRoll,
  quantizeNotes,
  reassignNotes,
  resolveNoteOverlaps,
  resizeNoteEnd,
  resizeNoteStart,
  setSelectedNoteDuration,
  shiftNotes,
  splitSelectedNotes,
  joinSelectedNotes,
} from "./project-editing";

const PITCHED_CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16];
const HISTORY_LIMIT = 50;
let userNoteSequence = 0;

function createUserNoteId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid !== undefined) {
    return `user-${randomUuid}`;
  }
  userNoteSequence += 1;
  return `user-${Date.now()}-${userNoteSequence}`;
}

function projectTimelineDurationSec(project: ProjectDocument): number {
  return Math.max(
    0.01,
    project.sourceAudio.durationSec +
      project.sourceAudio.timelineOffsetSec,
    ...project.notes.map(({ endSec }) => endSec),
  );
}

export interface ProjectStoreState {
  screen: "new-project" | "editor";
  project: ProjectDocument | null;
  recentSourceSelection: NewProjectSourceSelection | null;
  hasUnsavedChanges: boolean;
  model: ModelProfile | null;
  presetId: string | null;
  instrumentSelectionMode: InstrumentSelectionMode;
  transcriptionMode: "direct" | "separated";
  transcriptionProfile: TranscriptionProfile;
  separatedSettings: SeparatedTranscriptionSettings;
  inferenceBackend: InferenceBackend;
  playbackSource: PlaybackSource;
  job: {
    id: string;
    status: TranscriptionJobStatus;
    completed: number;
    total: number;
    error: string | null;
    detail?: string | null;
  } | null;
  selectedNoteIds: ReadonlySet<string>;
  canUndo: boolean;
  canRedo: boolean;
}

export interface NewProjectSourceSelection {
  audio: AudioInfo;
  name: string;
  bpm: number;
  beatOffsetSec: number;
}

const TERMINAL_JOB_STATUSES = new Set<TranscriptionJobStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export function isProjectEditingLocked(
  job: ProjectStoreState["job"],
): boolean {
  return job !== null && !TERMINAL_JOB_STATUSES.has(job.status);
}

export interface CreateProjectInput {
  name: string;
  audio: AudioInfo;
  bpm: number;
  beatOffsetSec?: number;
  numerator: number;
  denominator: 2 | 4 | 8 | 16;
  preset?: PresetDefinition;
  instruments: InstrumentDefinition[];
  instrumentSelectionMode?: InstrumentSelectionMode;
  model?: ModelProfile | null;
  mode?: "direct" | "separated";
  transcriptionProfile?: TranscriptionProfile;
  separatedSettings?: SeparatedTranscriptionSettings;
  backend?: InferenceBackend;
}

type Listener = () => void;

export const DEFAULT_SEPARATED_SETTINGS: SeparatedTranscriptionSettings = {
  drumOnsetGuide: true,
  timingGuideNoteFilter: true,
  velocityFromStemAmplitude: true,
};

interface EditSnapshot {
  sourceAudio: ProjectDocument["sourceAudio"];
  tempo: ProjectDocument["tempo"];
  notes: ProjectNote[];
  score: ScoreSettings;
  selectedNoteIds: ReadonlySet<string>;
  hasUnsavedChanges: boolean;
}

function notesAreEqual(left: ProjectNote, right: ProjectNote): boolean {
  return (
    left.id === right.id &&
    left.sourceInstrumentId === right.sourceInstrumentId &&
    left.trackId === right.trackId &&
    left.pitch === right.pitch &&
    left.rawStartSec === right.rawStartSec &&
    left.rawEndSec === right.rawEndSec &&
    left.startSec === right.startSec &&
    left.endSec === right.endSec &&
    left.velocity === right.velocity
  );
}

export function mergeTranscriptionNotes(
  previousAnalysis: readonly ProjectNote[],
  currentNotes: readonly ProjectNote[],
  nextAnalysis: readonly ProjectNote[],
): ProjectNote[] {
  const previousById = new Map(previousAnalysis.map((note) => [note.id, note]));
  const currentById = new Map(currentNotes.map((note) => [note.id, note]));
  const nextById = new Map(nextAnalysis.map((note) => [note.id, note]));
  const merged: ProjectNote[] = [];

  for (const nextNote of nextAnalysis) {
    const previousNote = previousById.get(nextNote.id);
    const currentNote = currentById.get(nextNote.id);
    if (previousNote === undefined) {
      merged.push(nextNote);
    } else if (currentNote === undefined) {
      continue;
    } else {
      merged.push(
        notesAreEqual(previousNote, currentNote) ? nextNote : currentNote,
      );
    }
  }

  for (const currentNote of currentNotes) {
    const previousNote = previousById.get(currentNote.id);
    if (previousNote === undefined) {
      merged.push(currentNote);
    } else if (
      !nextById.has(currentNote.id) &&
      !notesAreEqual(previousNote, currentNote)
    ) {
      merged.push(currentNote);
    }
  }

  return merged.sort(
    (left, right) =>
      left.startSec - right.startSec ||
      left.pitch - right.pitch ||
      left.id.localeCompare(right.id),
  );
}

export function limitAnalysisToPostTranscriptionOption(
  previousAnalysis: readonly ProjectNote[],
  collectedAnalysis: readonly ProjectNote[],
  tracks: ReadonlyArray<ProjectDocument["tracks"][number]>,
  option: PostTranscriptionOptionKey,
): ProjectNote[] {
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const affectedStemTypes = postTranscriptionOptionStemTypes(option);
  const isAffected = (note: ProjectNote): boolean => {
    const track = trackById.get(note.trackId);
    return (
      track !== undefined && affectedStemTypes.includes(stemTypeForTrack(track))
    );
  };

  return [
    ...previousAnalysis.filter((note) => !isAffected(note)),
    ...collectedAnalysis.filter(isAffected),
  ].sort(
    (left, right) =>
      left.startSec - right.startSec ||
      left.pitch - right.pitch ||
      left.id.localeCompare(right.id),
  );
}

export class ProjectStore {
  #state: ProjectStoreState = {
    screen: "new-project",
    project: null,
    recentSourceSelection: null,
    hasUnsavedChanges: false,
    model: null,
    presetId: null,
    instrumentSelectionMode: "fixed",
    transcriptionMode: "direct",
    transcriptionProfile: "high_accuracy",
    separatedSettings: DEFAULT_SEPARATED_SETTINGS,
    inferenceBackend: "Auto",
    playbackSource: "original",
    job: null,
    selectedNoteIds: new Set(),
    canUndo: false,
    canRedo: false,
  };
  #listeners = new Set<Listener>();
  #undoStack: EditSnapshot[] = [];
  #redoStack: EditSnapshot[] = [];
  #suppressedJobNoteIds = new Set<string>();
  #jobTrackOverrides = new Map<string, string>();
  #userJobNoteIds = new Set<string>();
  #analysisNotes: ProjectNote[] = [];
  #transcriptionInputResults: ProjectTranscriptionInputResult[] = [];

  constructor(
    private readonly idFactory: () => string = () => crypto.randomUUID(),
  ) {}

  getSnapshot = (): ProjectStoreState => this.#state;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  createProject(input: CreateProjectInput): void {
    if (!input.name.trim()) {
      throw new Error("プロジェクト名を入力してください");
    }
    if (input.bpm < 20 || input.bpm > 300) {
      throw new Error("BPMは20.0〜300.0で指定してください");
    }
    const instrumentMap = new Map(
      input.instruments.map((instrument) => [instrument.id, instrument]),
    );
    const instrumentSelectionMode = input.instrumentSelectionMode ?? "fixed";
    if (instrumentSelectionMode === "fixed" && input.preset === undefined) {
      throw new Error("楽器を指定する場合は編成プリセットが必要です");
    }
    let pitchedChannelIndex = 0;
    const tracks = (input.preset?.tracks ?? []).map((definition) => {
      const instrument = instrumentMap.get(definition.instrumentId);
      if (instrument === undefined) {
        throw new Error(`未対応の楽器です: ${definition.instrumentId}`);
      }
      const midiChannel =
        definition.kind === "drums"
          ? 10
          : PITCHED_CHANNELS[pitchedChannelIndex++];
      if (midiChannel === undefined) {
        throw new Error("音程トラックは最大15件です");
      }
      const gmProgram =
        definition.kind === "drums"
          ? null
          : definition.gmProgram ?? instrument.gmProgram;
      if (
        definition.kind !== "drums" &&
        !instrument.gmPrograms.some((option) => option.program === gmProgram)
      ) {
        throw new Error(
          `${instrument.displayNameJa}で使用できないGM音色です: ${gmProgram}`,
        );
      }
      return {
        ...definition,
        id: this.idFactory(),
        midiChannel,
        gmProgram,
        playbackOctaveShift: 0 as const,
        playbackVolume: DEFAULT_TRACK_PLAYBACK_VOLUME,
        mute: true,
        solo: false,
      };
    });
    this.#resetHistory();
    this.#resetJobNoteEdits();
    this.#analysisNotes = [];
    this.#transcriptionInputResults = [];
    this.#setState({
      screen: "editor",
      recentSourceSelection: {
        audio: { ...input.audio },
        name: input.name.trim(),
        bpm: input.bpm,
        beatOffsetSec: input.beatOffsetSec ?? 0,
      },
      hasUnsavedChanges: true,
      model: input.model ?? null,
      presetId: input.preset?.id ?? null,
      instrumentSelectionMode,
      transcriptionMode: input.mode ?? "direct",
      transcriptionProfile: input.transcriptionProfile ?? "high_accuracy",
      separatedSettings:
        input.separatedSettings ?? DEFAULT_SEPARATED_SETTINGS,
      inferenceBackend: input.backend ?? input.model?.defaultBackend ?? "Auto",
      playbackSource: "original",
      job: null,
      selectedNoteIds: new Set(),
      canUndo: false,
      canRedo: false,
      project: {
        formatVersion: 5,
        appVersion: "0.1.0",
        projectId: this.idFactory(),
        name: input.name.trim(),
        sourceAudio: {
          absolutePath: input.audio.absolutePath,
          relativePath: "",
          sha256: input.audio.sha256,
          durationSec: input.audio.durationSec,
          sampleRate: input.audio.sampleRate,
          channels: input.audio.channels,
          timelineOffsetSec: 0,
        },
        tempo: {
          bpm: input.bpm,
          beatOffsetSec: input.beatOffsetSec ?? 0,
          timeSignature: {
            numerator: input.numerator,
            denominator: input.denominator,
          },
          ppq: 480,
          quantizeGrid: "1/16",
        },
        transcription: null,
        tracks,
        notes: [],
        stems: [],
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
      },
    });
  }

  openProject(project: ProjectDocument, model: ModelProfile | null): void {
    if (project.formatVersion !== 5) {
      throw new Error(
        `未対応のプロジェクト形式です: ${project.formatVersion}`,
      );
    }
    const knownTrackIds = new Set(project.tracks.map((track) => track.id));
    if (project.notes.some((note) => !knownTrackIds.has(note.trackId))) {
      throw new Error("存在しないトラックを参照するノートがあります");
    }
    this.#resetHistory();
    this.#resetJobNoteEdits();
    this.#analysisNotes = project.transcription === null ? [] : project.notes;
    this.#transcriptionInputResults =
      project.transcription?.inputResults.map((result) => ({
        ...result,
        notes: result.notes.map((note) => ({ ...note })),
      })) ?? [];
    const playbackControls = resetPlaybackControlState(
      "original",
      project.tracks,
      project.stems,
    );
    this.#setState({
      screen: "editor",
      recentSourceSelection: {
        audio: {
          absolutePath: project.sourceAudio.absolutePath,
          sha256: project.sourceAudio.sha256,
          durationSec: project.sourceAudio.durationSec,
          sampleRate: project.sourceAudio.sampleRate,
          channels: project.sourceAudio.channels,
          codecName: "",
        },
        name: project.name,
        bpm: project.tempo.bpm,
        beatOffsetSec: project.tempo.beatOffsetSec,
      },
      hasUnsavedChanges: false,
      project: {
        ...project,
        notes: resolveNoteOverlaps(project.notes),
        tracks: playbackControls.tracks,
        stems: playbackControls.stems,
        score: project.score,
      },
      model,
      presetId: project.transcription?.presetId ?? null,
      instrumentSelectionMode:
        project.transcription?.instrumentSelectionMode ?? "fixed",
      transcriptionMode: project.transcription?.mode ?? "direct",
      transcriptionProfile:
        project.transcription === null
          ? "high_accuracy"
          : project.transcription.transcriptionProfile,
      separatedSettings: project.transcription
          ? {
            drumOnsetGuide: project.transcription.drumOnsetGuide,
            timingGuideNoteFilter:
              project.transcription.timingGuideNoteFilter,
            velocityFromStemAmplitude:
              project.transcription.velocityFromStemAmplitude,
          }
        : DEFAULT_SEPARATED_SETTINGS,
      inferenceBackend:
        project.transcription?.backend ?? model?.defaultBackend ?? "Auto",
      playbackSource: "original",
      job: project.transcription
        ? {
            id: "",
            status: "completed",
            completed: 0,
            total: 0,
            error: null,
            detail: null,
          }
        : null,
      selectedNoteIds: new Set(),
      canUndo: false,
      canRedo: false,
    });
  }

  selectPlaybackSource(source: PlaybackSource): void {
    const project = this.#requireProject();
    this.#setPlaybackControls(
      project,
      resetPlaybackControlState(source, project.tracks, project.stems),
      false,
      source,
    );
  }

  togglePlaybackTrackMute(trackId: string): void {
    const project = this.#requireProject();
    this.#setPlaybackControls(
      project,
      toggleTrackMuteState(
        this.#state.playbackSource,
        trackId,
        project.tracks,
        project.stems,
      ),
      true,
    );
  }

  togglePlaybackTrackSolo(trackId: string): void {
    const project = this.#requireProject();
    this.#setPlaybackControls(
      project,
      toggleTrackSoloState(
        this.#state.playbackSource,
        trackId,
        project.tracks,
        project.stems,
      ),
      true,
    );
  }

  togglePlaybackStemMute(stemType: StemType): void {
    const project = this.#requireProject();
    this.#setPlaybackControls(
      project,
      toggleStemMuteState(
        this.#state.playbackSource,
        stemType,
        project.tracks,
        project.stems,
      ),
      true,
    );
  }

  togglePlaybackStemSolo(stemType: StemType): void {
    const project = this.#requireProject();
    this.#setPlaybackControls(
      project,
      toggleStemSoloState(
        this.#state.playbackSource,
        stemType,
        project.tracks,
        project.stems,
      ),
      true,
    );
  }

  #setPlaybackControls(
    project: ProjectDocument,
    controls: PlaybackControlState,
    markUnsaved: boolean,
    playbackSource = this.#state.playbackSource,
  ): void {
    const tracksChanged = controls.tracks.some(
      (track, index) =>
        track.mute !== project.tracks[index]?.mute ||
        track.solo !== project.tracks[index]?.solo,
    );
    const stemsChanged = controls.stems.some(
      (stem, index) =>
        stem.mute !== project.stems[index]?.mute ||
        stem.solo !== project.stems[index]?.solo,
    );
    if (
      !tracksChanged &&
      !stemsChanged &&
      playbackSource === this.#state.playbackSource
    ) {
      return;
    }
    this.#setState({
      ...this.#state,
      playbackSource,
      hasUnsavedChanges: markUnsaved || this.#state.hasUnsavedChanges,
      project: {
        ...project,
        tracks: controls.tracks,
        stems: controls.stems,
      },
    });
  }

  setPlaybackOctaveShift(trackId: string, shift: 0 | 1): void {
    this.#updateTrack(trackId, (track) => ({
      ...track,
      playbackOctaveShift: shift,
    }));
  }

  setPlaybackVolume(trackId: string, volume: number): void {
    if (
      !Number.isInteger(volume) ||
      volume < MIN_TRACK_PLAYBACK_VOLUME ||
      volume > MAX_TRACK_PLAYBACK_VOLUME
    ) {
      throw new Error("再生音量は0〜100の整数で指定してください");
    }
    this.#updateTrack(trackId, (track) => ({
      ...track,
      playbackVolume: volume,
    }));
  }

  setBpm(bpm: number): void {
    if (bpm < 20 || bpm > 300) {
      throw new Error("BPMは20.0〜300.0で指定してください");
    }
    const project = this.#requireProject();
    if (project.tempo.bpm === bpm) {
      return;
    }
    this.#commitEdit({
      ...project,
      tempo: { ...project.tempo, bpm },
    });
  }

  setSelectedNoteAsMeasureStart(): void {
    if (this.#state.selectedNoteIds.size !== 1) {
      throw new Error("小節先頭に設定するノートを1件選択してください");
    }
    const project = this.#requireProject();
    const selectedNoteId = this.#state.selectedNoteIds.values().next().value;
    const note = project.notes.find(
      (candidate) => candidate.id === selectedNoteId,
    );
    if (note === undefined) {
      throw new Error("選択ノートが見つかりません");
    }
    const signature = project.tempo.timeSignature;
    const beatDurationSec =
      (60 / project.tempo.bpm) * (4 / signature.denominator);
    const measureDurationSec = beatDurationSec * signature.numerator;
    const remainder = note.startSec % measureDurationSec;
    const beatOffsetSec =
      remainder < 1e-9 || measureDurationSec - remainder < 1e-9
        ? 0
        : remainder;
    if (project.tempo.beatOffsetSec === beatOffsetSec) {
      return;
    }
    this.#commitEdit({
      ...project,
      tempo: { ...project.tempo, beatOffsetSec },
    });
  }

  beginJob(jobId: string): void {
    this.#requireProject();
    if (
      this.#state.job === null ||
      TERMINAL_JOB_STATUSES.has(this.#state.job.status)
    ) {
      this.#resetJobNoteEdits();
      this.#transcriptionInputResults = [];
    }
    this.#resetHistory();
    this.#setState({
      ...this.#state,
      job: {
        id: jobId,
        status: "waiting",
        completed: 0,
        total: 0,
        error: null,
        detail: null,
      },
    });
  }

  applyJobEvent(event: TranscriptionJobEvent): void {
    if (this.#state.job === null) {
      throw new Error("採譜ジョブが開始されていません");
    }
    if (event.type === "state") {
      if (event.status === "completed") {
        this.#resetHistory();
      }
      const currentProject = this.#state.project;
      const model = this.#state.model;
      const project =
        currentProject !== null && TERMINAL_JOB_STATUSES.has(event.status)
          ? {
              ...currentProject,
              notes: [
                ...resolveNoteOverlaps(
                  currentProject.notes.filter(
                    ({ id }) => !this.#userJobNoteIds.has(id),
                  ),
                ),
                ...currentProject.notes.filter(({ id }) =>
                  this.#userJobNoteIds.has(id),
                ),
              ].sort(
                (left, right) =>
                  left.startSec - right.startSec ||
                  left.pitch - right.pitch ||
                  left.id.localeCompare(right.id),
              ),
            }
          : currentProject;
      const canCompleteTranscription =
        event.status === "completed" &&
        project !== null &&
        model !== null &&
        (this.#state.instrumentSelectionMode === "automatic" ||
          this.#state.presetId !== null);
      if (
        canCompleteTranscription &&
        !this.#transcriptionInputResults.some(
          (result) => result.role === "primary",
        )
      ) {
        throw new Error("採譜入力別ノートにprimaryがありません");
      }
      const completedTranscription =
        canCompleteTranscription
          ? {
              mode: this.#state.transcriptionMode,
              transcriptionProfile: this.#state.transcriptionProfile,
              instrumentSelectionMode: this.#state.instrumentSelectionMode,
              ...this.#state.separatedSettings,
              presetId: this.#state.presetId,
              modelProfileId: model.id,
              modelSha256: model.sha256,
              backend:
                event.backend ??
                (this.#state.inferenceBackend === "Auto"
                  ? ("CPU" as const)
                  : this.#state.inferenceBackend),
              completedAt: new Date().toISOString(),
              inputResults: this.#transcriptionInputResults.map((result) => ({
                ...result,
                notes: result.notes.map((note) => ({ ...note })),
              })),
            }
          : null;
      const nextProject =
        project !== null && completedTranscription !== null
          ? { ...project, transcription: completedTranscription }
          : project;
      if (event.status === "completed" && nextProject !== null) {
        this.#analysisNotes = nextProject.notes.filter(
          ({ id }) => !this.#userJobNoteIds.has(id),
        );
      }
      this.#setState({
        ...this.#state,
        job: {
          ...this.#state.job,
          status: event.status,
          completed:
            this.#state.job.status === "separating" &&
            event.status !== "separating"
              ? 0
              : this.#state.job.completed,
          total:
            this.#state.job.status === "separating" &&
            event.status !== "separating"
              ? 0
              : this.#state.job.total,
          detail: null,
        },
        project: nextProject,
        hasUnsavedChanges:
          nextProject !== project
            ? true
            : this.#state.hasUnsavedChanges,
      });
      return;
    }
    if (event.type === "transcription_input_result") {
      const { type: _type, ...inputResult } = event;
      const key = `${inputResult.inputName}:${inputResult.role}`;
      this.#transcriptionInputResults = [
        ...this.#transcriptionInputResults.filter(
          (result) => `${result.inputName}:${result.role}` !== key,
        ),
        {
          ...inputResult,
          notes: inputResult.notes.map((note) => ({ ...note })),
        },
      ];
      return;
    }
    if (event.type === "progress") {
      this.#setState({
        ...this.#state,
        job: {
          ...this.#state.job,
          status: event.stage,
          completed: event.completed,
          total: event.total,
          detail:
            event.stage === "transcribing"
              ? transcriptionPassProgressDetail(event)
              : null,
        },
      });
      return;
    }
    if (event.type === "partial_result") {
      const discardedNoteCount =
        (event.invalidChunkDiscardedNoteCount ?? 0) +
        (event.audioTailDiscardedNoteCount ?? 0) +
        (event.pathologicalChainDiscardedNoteCount ?? 0) +
        (event.mappedDuplicateDiscardedNoteCount ?? 0);
      const discardDetail =
        discardedNoteCount > 0
          ? `, 異常推定${discardedNoteCount}音を除外`
          : "";
      this.#setState({
        ...this.#state,
        job: {
          ...this.#state.job,
          status: "transcribing",
          detail: transcriptionPassCompletion(
            event,
            `${event.noteCount}音${discardDetail}`,
          ),
        },
      });
      return;
    }
    if (event.type === "note_cleanup") {
      this.removeJobNotes(event.removedNoteIds);
      return;
    }
    if (event.type === "error") {
      this.#setState({
        ...this.#state,
        job: {
          ...this.#state.job,
          status: "failed",
          error: event.message,
        },
      });
      return;
    }
    if (event.type === "stem") {
      this.#resetHistory();
      const project = this.#requireProject();
      const supersededTypes = stemTypesSupersededBy(event.stem.type);
      const retainedStems = project.stems.filter(
        (stem) => !supersededTypes.has(stem.type),
      );
      const replacedStem = project.stems.find(
        (stem) => stem.type === event.stem.type,
      );
      const controls =
        replacedStem === undefined
          ? addStemToPlaybackControlState(
              this.#state.playbackSource,
              event.stem,
              project.tracks,
              retainedStems,
            )
          : {
              tracks: [...project.tracks],
              stems: [
                ...retainedStems,
                {
                  ...event.stem,
                  mute: replacedStem.mute,
                  solo: replacedStem.solo,
                },
              ],
            };
      this.#setState({
        ...this.#state,
        hasUnsavedChanges: true,
        project: {
          ...project,
          tracks: controls.tracks,
          stems: controls.stems,
        },
      });
      return;
    }
    if (event.type === "track") {
      const project = this.#requireProject();
      const existing = project.tracks.find(
        (track) =>
          track.id === event.track.id ||
          track.instrumentId === event.track.instrumentId,
      );
      if (existing !== undefined) {
        return;
      }
      if (project.tracks.length >= 16) {
        throw new Error("自動推定トラックは最大16件です");
      }
      this.#resetHistory();
      const controls = addTrackToPlaybackControlState(
        this.#state.playbackSource,
        {
          ...event.track,
          playbackVolume: DEFAULT_TRACK_PLAYBACK_VOLUME,
        },
        project.tracks,
        project.stems,
      );
      this.#setState({
        ...this.#state,
        hasUnsavedChanges: true,
        project: {
          ...project,
          tracks: controls.tracks.sort(
            (left, right) => left.order - right.order,
          ),
          stems: controls.stems,
        },
      });
      return;
    }
    this.applyJobNoteEvents([event]);
  }

  applyJobNoteEvents(events: readonly JobNoteEvent[]): void {
    if (events.length === 0) {
      return;
    }
    if (this.#state.job === null) {
      throw new Error("採譜ジョブが開始されていません");
    }
    const notes = events.map(({ type: _type, ...note }) => note);
    this.#resetHistory();
    this.#upsertNotes(notes);
  }

  removeJobNotes(noteIds: Iterable<string>): void {
    const removing = new Set(noteIds);
    if (removing.size === 0 || this.#state.project === null) {
      return;
    }
    const notes = this.#state.project.notes.filter(
      (note) => !removing.has(note.id),
    );
    if (notes.length === this.#state.project.notes.length) {
      return;
    }
    this.#setState({
      ...this.#state,
      project: { ...this.#state.project, notes },
      selectedNoteIds: new Set(
        [...this.#state.selectedNoteIds].filter((id) => !removing.has(id)),
      ),
    });
  }

  failJob(message: string): void {
    const current = this.#state.job ?? {
      id: "",
      status: "waiting" as const,
      completed: 0,
      total: 0,
      error: null,
    };
    this.#setState({
      ...this.#state,
      job: {
        ...current,
        status: "failed",
        error: message,
        detail: null,
      },
    });
  }

  setSeparatedSettings(settings: SeparatedTranscriptionSettings): void {
    this.#setState({
      ...this.#state,
      separatedSettings: { ...settings },
    });
  }

  getTranscriptionAnalysisNotes(): ProjectNote[] {
    return this.#analysisNotes.map((note) => ({ ...note }));
  }

  applyStemAmplitudeVelocityResult(
    velocityResult: readonly ProjectNote[],
    enabled: boolean,
  ): void {
    const project = this.#requireProject();
    if (
      project.transcription === null ||
      project.transcription.mode !== "separated"
    ) {
      throw new Error("音源分離後の採譜結果が必要です");
    }
    const velocityById = new Map(
      velocityResult.map((note) => [note.id, note.velocity]),
    );
    if (
      velocityById.size !== this.#analysisNotes.length ||
      this.#analysisNotes.some((note) => !velocityById.has(note.id))
    ) {
      throw new Error("ベロシティ更新結果のノートIDが採譜結果と一致しません");
    }
    const nextAnalysis = this.#analysisNotes.map((note) => ({
      ...note,
      velocity: velocityById.get(note.id)!,
    }));
    const notes = this.#replaceTranscriptionAnalysis(project, nextAnalysis);
    this.#setState({
      ...this.#state,
      hasUnsavedChanges: true,
      project: {
        ...project,
        notes,
        transcription: {
          ...project.transcription,
          velocityFromStemAmplitude: enabled,
        },
      },
    });
  }

  applySavedTranscriptionOptionResult(
    resultNotes: readonly ProjectNote[],
    settings: SeparatedTranscriptionSettings,
    option: PostTranscriptionOptionKey,
    inputResults?: readonly ProjectTranscriptionInputResult[],
  ): void {
    const project = this.#requireProject();
    if (project.transcription === null) {
      throw new Error("採譜オプションを適用できる採譜結果がありません");
    }
    const collectedAnalysis = resolveNoteOverlaps([...resultNotes]);
    const nextAnalysis = limitAnalysisToPostTranscriptionOption(
      this.#analysisNotes,
      collectedAnalysis,
      project.tracks,
      option,
    );
    const notes = this.#replaceTranscriptionAnalysis(project, nextAnalysis);
    const knownNoteIds = new Set(notes.map((note) => note.id));
    this.#transcriptionInputResults = (
      inputResults ?? project.transcription.inputResults
    ).map((result) => ({
      ...result,
      notes: result.notes.map((note) => ({ ...note })),
    }));
    this.#setState({
      ...this.#state,
      hasUnsavedChanges: true,
      project: {
        ...project,
        notes,
        transcription: {
          ...project.transcription,
          ...settings,
          inputResults: this.#transcriptionInputResults.map((result) => ({
            ...result,
            notes: result.notes.map((note) => ({ ...note })),
          })),
        },
      },
      selectedNoteIds: new Set(
        [...this.#state.selectedNoteIds].filter((id) => knownNoteIds.has(id)),
      ),
    });
  }

  #replaceTranscriptionAnalysis(
    project: ProjectDocument,
    nextAnalysis: readonly ProjectNote[],
  ): ProjectNote[] {
    const notes = mergeTranscriptionNotes(
      this.#analysisNotes,
      project.notes,
      nextAnalysis,
    );
    const rebaseSnapshot = (snapshot: EditSnapshot): EditSnapshot => {
      const rebasedNotes = mergeTranscriptionNotes(
        this.#analysisNotes,
        snapshot.notes,
        nextAnalysis,
      );
      const knownIds = new Set(rebasedNotes.map((note) => note.id));
      return {
        ...snapshot,
        notes: rebasedNotes,
        selectedNoteIds: new Set(
          [...snapshot.selectedNoteIds].filter((id) => knownIds.has(id)),
        ),
      };
    };
    this.#undoStack = this.#undoStack.map(rebaseSnapshot);
    this.#redoStack = this.#redoStack.map(rebaseSnapshot);
    this.#analysisNotes = [...nextAnalysis];
    return notes;
  }

  setSelection(noteIds: Iterable<string>): void {
    const project = this.#requireProject();
    const knownIds = new Set(project.notes.map((note) => note.id));
    const selection = new Set(
      [...noteIds].filter((noteId) => knownIds.has(noteId)),
    );
    this.#setState({ ...this.#state, selectedNoteIds: selection });
  }

  updateScoreSettings(update: Partial<ScoreSettings>): void {
    const project = this.#requireProject();
    const score = { ...project.score, ...update };
    if (JSON.stringify(score) === JSON.stringify(project.score)) {
      return;
    }
    this.#commitEdit({ ...project, score });
  }

  toggleNoteSelection(noteId: string, additive: boolean): void {
    const project = this.#requireProject();
    if (!project.notes.some((note) => note.id === noteId)) {
      return;
    }
    const selection = additive
      ? new Set(this.#state.selectedNoteIds)
      : new Set<string>();
    if (additive && selection.has(noteId)) {
      selection.delete(noteId);
    } else {
      selection.add(noteId);
    }
    this.#setState({ ...this.#state, selectedNoteIds: selection });
  }

  clearSelection(): void {
    if (this.#state.selectedNoteIds.size > 0) {
      this.#setState({ ...this.#state, selectedNoteIds: new Set() });
    }
  }

  moveSelectedNotes(targetTrackId: string): void {
    const project = this.#requireProject();
    if (!project.tracks.some((track) => track.id === targetTrackId)) {
      throw new Error(`移動先トラックが見つかりません: ${targetTrackId}`);
    }
    const result = reassignNotes(
      project.notes,
      this.#state.selectedNoteIds,
      targetTrackId,
      project.tempo.bpm,
    );
    const editingLocked = isProjectEditingLocked(this.#state.job);
    const notes = editingLocked
      ? result.notes
      : resolveNoteOverlaps(result.notes);
    const knownIds = new Set(notes.map((note) => note.id));
    const selectedNoteIds = new Set(
      [...result.selectedIds].filter((noteId) => knownIds.has(noteId)),
    );
    if (editingLocked) {
      for (const note of project.notes) {
        if (!knownIds.has(note.id)) {
          this.#suppressedJobNoteIds.add(note.id);
          this.#jobTrackOverrides.delete(note.id);
        }
      }
      for (const noteId of selectedNoteIds) {
        this.#jobTrackOverrides.set(noteId, targetTrackId);
      }
      this.#setState({
        ...this.#state,
        project: { ...project, notes },
        selectedNoteIds,
        hasUnsavedChanges: true,
      });
      return;
    }
    this.#commitEdit(
      { ...project, notes },
      selectedNoteIds,
    );
  }

  quantizeAll(grid: QuantizeGrid): void {
    const project = this.#requireProject();
    const notes = resolveNoteOverlaps(
      quantizeNotes(
        project.notes,
        project.tempo.bpm,
        grid,
        project.tempo.beatOffsetSec,
      ),
    );
    const knownIds = new Set(notes.map((note) => note.id));
    this.#commitEdit(
      {
        ...project,
        tempo: { ...project.tempo, quantizeGrid: grid },
        notes,
      },
      new Set(
        [...this.#state.selectedNoteIds].filter((noteId) =>
          knownIds.has(noteId),
        ),
      ),
    );
  }

  shiftAllNotes(offsetSec: number): void {
    const project = this.#requireProject();
    const notes = shiftNotes(project.notes, offsetSec);
    if (notes === project.notes) {
      return;
    }
    const previousStartSec = project.notes.reduce(
      (earliest, note) => Math.min(earliest, note.startSec),
      Number.POSITIVE_INFINITY,
    );
    const nextStartSec = notes.reduce(
      (earliest, note) => Math.min(earliest, note.startSec),
      Number.POSITIVE_INFINITY,
    );
    const appliedOffsetSec = nextStartSec - previousStartSec;
    this.#commitEdit({
      ...project,
      sourceAudio: {
        ...project.sourceAudio,
        timelineOffsetSec:
          project.sourceAudio.timelineOffsetSec + appliedOffsetSec,
      },
      notes,
    });
  }

  shiftTrackNotes(trackId: string, offsetSec: number): void {
    const project = this.#requireProject();
    if (!project.tracks.some((track) => track.id === trackId)) {
      throw new Error(`トラックが見つかりません: ${trackId}`);
    }
    const targetNotes = project.notes.filter(
      (note) => note.trackId === trackId,
    );
    const shiftedNotes = shiftNotes(targetNotes, offsetSec);
    if (shiftedNotes === targetNotes) {
      return;
    }
    const notes = resolveNoteOverlaps([
      ...project.notes.filter((note) => note.trackId !== trackId),
      ...shiftedNotes,
    ]);
    this.#commitEdit({ ...project, notes });
  }

  moveSelectedNotesInTime(offsetSec: number): void {
    this.moveSelectedNotesOnPianoRoll(offsetSec, 0);
  }

  addNote(input: {
    trackId: string;
    pitch: number;
    startSec: number;
    endSec: number;
    velocity?: number;
  }): void {
    const project = this.#requireProject();
    const track = project.tracks.find(({ id }) => id === input.trackId);
    if (track === undefined) {
      throw new Error(`トラックが見つかりません: ${input.trackId}`);
    }
    if (!Number.isInteger(input.pitch) || input.pitch < 0 || input.pitch > 127) {
      throw new Error("音高が不正です");
    }
    if (!Number.isFinite(input.startSec) || !Number.isFinite(input.endSec)) {
      throw new Error("ノート位置が不正です");
    }
    const startSec = Math.min(
      projectTimelineDurationSec(project),
      Math.max(0, input.startSec),
    );
    const endSec = Math.min(
      projectTimelineDurationSec(project),
      Math.max(startSec + 0.01, input.endSec),
    );
    if (endSec <= startSec) {
      return;
    }
    const note: ProjectNote = {
      id: createUserNoteId(),
      sourceInstrumentId: track.instrumentId,
      trackId: track.id,
      pitch: input.pitch,
      rawStartSec: startSec,
      rawEndSec: endSec,
      startSec,
      endSec,
      velocity: Math.min(127, Math.max(1, input.velocity ?? 100)),
    };
    if (isProjectEditingLocked(this.#state.job)) {
      this.#userJobNoteIds.add(note.id);
      this.#setState({
        ...this.#state,
        project: {
          ...project,
          notes: [...project.notes, note].sort(
            (left, right) =>
              left.startSec - right.startSec ||
              left.pitch - right.pitch ||
              left.id.localeCompare(right.id),
          ),
        },
        selectedNoteIds: new Set([note.id]),
        hasUnsavedChanges: true,
      });
      return;
    }
    const notes = resolveNoteOverlaps([...project.notes, note]);
    const selectedNoteIds = notes.some(({ id }) => id === note.id)
      ? new Set([note.id])
      : new Set<string>();
    this.#commitEdit({ ...project, notes }, selectedNoteIds);
  }

  moveSelectedNotesOnPianoRoll(offsetSec: number, pitchOffset: number): void {
    const project = this.#requireProject();
    const moved = moveNotesOnPianoRoll(
      project.notes,
      this.#state.selectedNoteIds,
      offsetSec,
      pitchOffset,
      projectTimelineDurationSec(project),
    );
    if (moved === project.notes) {
      return;
    }
    const notes = resolveNoteOverlaps(moved);
    const knownIds = new Set(notes.map((note) => note.id));
    this.#commitEdit(
      { ...project, notes },
      new Set(
        [...this.#state.selectedNoteIds].filter((noteId) =>
          knownIds.has(noteId),
        ),
      ),
    );
  }

  resizeNoteEnd(noteId: string, endSec: number): void {
    const project = this.#requireProject();
    const resized = resizeNoteEnd(
      project.notes,
      noteId,
      endSec,
      projectTimelineDurationSec(project),
    );
    if (resized === project.notes) {
      return;
    }
    const notes = resolveNoteOverlaps(resized);
    const knownIds = new Set(notes.map((note) => note.id));
    this.#commitEdit(
      { ...project, notes },
      new Set(
        [...this.#state.selectedNoteIds].filter((selectedId) =>
          knownIds.has(selectedId),
        ),
      ),
    );
  }

  resizeNoteStart(noteId: string, startSec: number): void {
    const project = this.#requireProject();
    const resized = resizeNoteStart(project.notes, noteId, startSec);
    if (resized === project.notes) {
      return;
    }
    const notes = resolveNoteOverlaps(resized);
    const knownIds = new Set(notes.map((note) => note.id));
    this.#commitEdit(
      { ...project, notes },
      new Set(
        [...this.#state.selectedNoteIds].filter((selectedId) =>
          knownIds.has(selectedId),
        ),
      ),
    );
  }

  setSelectedNoteDuration(durationSec: number): void {
    const project = this.#requireProject();
    const updated = setSelectedNoteDuration(
      project.notes,
      this.#state.selectedNoteIds,
      durationSec,
      projectTimelineDurationSec(project),
    );
    if (updated === project.notes) {
      return;
    }
    const notes = resolveNoteOverlaps(updated);
    const knownIds = new Set(notes.map((note) => note.id));
    this.#commitEdit(
      { ...project, notes },
      new Set(
        [...this.#state.selectedNoteIds].filter((selectedId) =>
          knownIds.has(selectedId),
        ),
      ),
    );
  }

  splitSelectedNotes(splitSec: number): void {
    const project = this.#requireProject();
    const result = splitSelectedNotes(
      project.notes,
      this.#state.selectedNoteIds,
      splitSec,
      createUserNoteId,
    );
    if (result.notes === project.notes) {
      return;
    }
    this.#commitEdit({ ...project, notes: result.notes }, result.selectedIds);
  }

  joinSelectedNotes(maximumGapSec: number): void {
    const project = this.#requireProject();
    const result = joinSelectedNotes(
      project.notes,
      this.#state.selectedNoteIds,
      maximumGapSec,
    );
    if (result.notes === project.notes) {
      return;
    }
    this.#commitEdit({ ...project, notes: result.notes }, result.selectedIds);
  }

  copySelectedNotes(): ProjectNote[] {
    const project = this.#requireProject();
    return project.notes
      .filter((note) => this.#state.selectedNoteIds.has(note.id))
      .map((note) => ({ ...note }))
      .sort(
        (left, right) =>
          left.startSec - right.startSec ||
          left.pitch - right.pitch ||
          left.id.localeCompare(right.id),
      );
  }

  pasteNotes(sourceNotes: readonly ProjectNote[], targetStartSec: number): void {
    const project = this.#requireProject();
    if (sourceNotes.length === 0 || !Number.isFinite(targetStartSec)) {
      return;
    }
    const trackIds = new Set(project.tracks.map((track) => track.id));
    const sourceStartSec = Math.min(...sourceNotes.map((note) => note.startSec));
    const durationSec = projectTimelineDurationSec(project);
    const pasted = sourceNotes
      .filter((note) => trackIds.has(note.trackId))
      .map((note) => {
        const startSec = Math.max(0, targetStartSec + note.startSec - sourceStartSec);
        const endSec = Math.min(
          durationSec,
          Math.max(startSec + 0.01, startSec + note.endSec - note.startSec),
        );
        return {
          ...note,
          id: createUserNoteId(),
          rawStartSec: startSec,
          rawEndSec: endSec,
          startSec,
          endSec,
        };
      })
      .filter((note) => note.endSec > note.startSec);
    if (pasted.length === 0) {
      return;
    }
    if (isProjectEditingLocked(this.#state.job)) {
      for (const note of pasted) {
        this.#userJobNoteIds.add(note.id);
      }
      this.#setState({
        ...this.#state,
        project: {
          ...project,
          notes: [...project.notes, ...pasted].sort(
            (left, right) =>
              left.startSec - right.startSec ||
              left.pitch - right.pitch ||
              left.id.localeCompare(right.id),
          ),
        },
        selectedNoteIds: new Set(pasted.map((note) => note.id)),
        hasUnsavedChanges: true,
      });
      return;
    }
    const notes = resolveNoteOverlaps([...project.notes, ...pasted]);
    const knownIds = new Set(notes.map((note) => note.id));
    this.#commitEdit(
      { ...project, notes },
      new Set(pasted.map((note) => note.id).filter((id) => knownIds.has(id))),
    );
  }

  deleteSelectedNotes(): void {
    this.deleteNotesByIds(this.#state.selectedNoteIds);
  }

  deleteNotesByIds(noteIds: ReadonlySet<string>): void {
    const project = this.#requireProject();
    const notes = deleteNotes(project.notes, noteIds);
    if (notes === project.notes) {
      return;
    }
    if (isProjectEditingLocked(this.#state.job)) {
      for (const noteId of noteIds) {
        this.#suppressedJobNoteIds.add(noteId);
        this.#jobTrackOverrides.delete(noteId);
        this.#userJobNoteIds.delete(noteId);
      }
      this.#setState({
        ...this.#state,
        project: { ...project, notes },
        selectedNoteIds: new Set(
          [...this.#state.selectedNoteIds].filter(
            (selectedId) => !noteIds.has(selectedId),
          ),
        ),
        hasUnsavedChanges: true,
      });
      return;
    }
    const knownIds = new Set(notes.map(({ id }) => id));
    this.#commitEdit(
      { ...project, notes },
      new Set(
        [...this.#state.selectedNoteIds].filter((selectedId) =>
          knownIds.has(selectedId),
        ),
      ),
    );
  }

  markSaved(project: ProjectDocument): void {
    if (this.#state.project !== project) {
      return;
    }
    this.#setState({
      ...this.#state,
      hasUnsavedChanges: false,
    });
  }

  undo(): void {
    this.#requireEditingUnlocked();
    const snapshot = this.#undoStack.pop();
    if (snapshot === undefined) {
      return;
    }
    this.#redoStack.push(this.#captureSnapshot());
    this.#restoreSnapshot(snapshot);
  }

  redo(): void {
    this.#requireEditingUnlocked();
    const snapshot = this.#redoStack.pop();
    if (snapshot === undefined) {
      return;
    }
    this.#undoStack.push(this.#captureSnapshot());
    this.#restoreSnapshot(snapshot);
  }

  setActiveRoll(activeRoll: "pitched" | "drums"): void {
    const project = this.#requireProject();
    this.#setState({
      ...this.#state,
      selectedNoteIds: new Set(),
      project: {
        ...project,
        viewState: { ...project.viewState, activeRoll },
      },
    });
  }

  setZoom(horizontalZoom: number, verticalZoom: number): void {
    const project = this.#requireProject();
    this.#setState({
      ...this.#state,
      project: {
        ...project,
        viewState: {
          ...project.viewState,
          horizontalZoom: Math.min(4, Math.max(0.25, horizontalZoom)),
          verticalZoom: Math.min(3, Math.max(0.5, verticalZoom)),
        },
      },
    });
  }

  setScrollTime(scrollTimeSec: number): void {
    const project = this.#requireProject();
    const normalized = Math.max(0, scrollTimeSec);
    if (Math.abs(project.viewState.scrollTimeSec - normalized) < 0.01) {
      return;
    }
    this.#setState({
      ...this.#state,
      project: {
        ...project,
        viewState: { ...project.viewState, scrollTimeSec: normalized },
      },
    });
  }

  closeProject(): void {
    const project = this.#state.project;
    const recentSourceSelection =
      project === null
        ? this.#state.recentSourceSelection
        : {
            audio: {
              absolutePath: project.sourceAudio.absolutePath,
              sha256: project.sourceAudio.sha256,
              durationSec: project.sourceAudio.durationSec,
              sampleRate: project.sourceAudio.sampleRate,
              channels: project.sourceAudio.channels,
              codecName:
                this.#state.recentSourceSelection?.audio.absolutePath ===
                project.sourceAudio.absolutePath
                  ? this.#state.recentSourceSelection.audio.codecName
                  : "",
            },
            name: project.name,
            bpm: project.tempo.bpm,
            beatOffsetSec: project.tempo.beatOffsetSec,
          };
    this.#resetHistory();
    this.#resetJobNoteEdits();
    this.#analysisNotes = [];
    this.#transcriptionInputResults = [];
    this.#setState({
      screen: "new-project",
      project: null,
      recentSourceSelection,
      hasUnsavedChanges: false,
      model: null,
      presetId: null,
      instrumentSelectionMode: "fixed",
      transcriptionMode: "direct",
      transcriptionProfile: "high_accuracy",
      separatedSettings: DEFAULT_SEPARATED_SETTINGS,
      inferenceBackend: "Auto",
      playbackSource: "original",
      job: null,
      selectedNoteIds: new Set(),
      canUndo: false,
      canRedo: false,
    });
  }

  #upsertNotes(incomingNotes: readonly ProjectNote[]): void {
    const project = this.#requireProject();
    const trackIds = new Set(project.tracks.map((track) => track.id));
    const acceptedNotes = incomingNotes
      .filter((note) => !this.#suppressedJobNoteIds.has(note.id))
      .map((note) => {
        const trackId = this.#jobTrackOverrides.get(note.id);
        return trackId === undefined ? note : { ...note, trackId };
      });
    if (acceptedNotes.length === 0) {
      return;
    }
    for (const note of acceptedNotes) {
      if (!trackIds.has(note.trackId)) {
        throw new Error(`ノートのトラックが見つかりません: ${note.trackId}`);
      }
    }
    const incomingById = new Map(acceptedNotes.map((note) => [note.id, note]));
    const notes = project.notes.filter(
      (existing) => !incomingById.has(existing.id),
    );
    notes.push(...incomingById.values());
    const resolvedNotes = isProjectEditingLocked(this.#state.job)
      ? notes.sort(
          (left, right) =>
            left.startSec - right.startSec ||
            left.pitch - right.pitch ||
            left.id.localeCompare(right.id),
        )
      : resolveNoteOverlaps(notes);
    const knownIds = new Set(resolvedNotes.map((item) => item.id));
    this.#setState({
      ...this.#state,
      hasUnsavedChanges: true,
      project: { ...project, notes: resolvedNotes },
      selectedNoteIds: new Set(
        [...this.#state.selectedNoteIds].filter((noteId) =>
          knownIds.has(noteId),
        ),
      ),
    });
  }

  #updateTrack(
    trackId: string,
    update: (track: ProjectDocument["tracks"][number]) => ProjectDocument["tracks"][number],
  ): void {
    const project = this.#requireProject();
    if (!project.tracks.some((track) => track.id === trackId)) {
      throw new Error(`トラックが見つかりません: ${trackId}`);
    }
    this.#setState({
      ...this.#state,
      hasUnsavedChanges: true,
      project: {
        ...project,
        tracks: project.tracks.map((track) =>
          track.id === trackId ? update(track) : track,
        ),
      },
    });
  }

  #requireProject(): ProjectDocument {
    if (this.#state.project === null) {
      throw new Error("プロジェクトが開かれていません");
    }
    return this.#state.project;
  }

  #captureSnapshot(): EditSnapshot {
    const project = this.#requireProject();
    return {
      sourceAudio: project.sourceAudio,
      tempo: project.tempo,
      notes: project.notes,
      score: project.score,
      selectedNoteIds: new Set(this.#state.selectedNoteIds),
      hasUnsavedChanges: this.#state.hasUnsavedChanges,
    };
  }

  #commitEdit(
    project: ProjectDocument,
    selectedNoteIds: ReadonlySet<string> = this.#state.selectedNoteIds,
  ): void {
    this.#requireEditingUnlocked();
    this.#undoStack.push(this.#captureSnapshot());
    if (this.#undoStack.length > HISTORY_LIMIT) {
      this.#undoStack.shift();
    }
    this.#redoStack = [];
    this.#setState({
      ...this.#state,
      project,
      selectedNoteIds: new Set(selectedNoteIds),
      hasUnsavedChanges: true,
    });
  }

  #requireEditingUnlocked(): void {
    if (isProjectEditingLocked(this.#state.job)) {
      throw new Error("採譜中は編集できません");
    }
  }

  #restoreSnapshot(snapshot: EditSnapshot): void {
    const project = this.#requireProject();
    const knownIds = new Set(snapshot.notes.map((note) => note.id));
    this.#setState({
      ...this.#state,
      project: {
        ...project,
        sourceAudio: snapshot.sourceAudio,
        tempo: snapshot.tempo,
        notes: snapshot.notes,
        score: snapshot.score,
      },
      hasUnsavedChanges: snapshot.hasUnsavedChanges,
      selectedNoteIds: new Set(
        [...snapshot.selectedNoteIds].filter((noteId) =>
          knownIds.has(noteId),
        ),
      ),
    });
  }

  #resetHistory(): void {
    this.#undoStack = [];
    this.#redoStack = [];
  }

  #resetJobNoteEdits(): void {
    this.#suppressedJobNoteIds.clear();
    this.#jobTrackOverrides.clear();
    this.#userJobNoteIds.clear();
  }

  #setState(state: ProjectStoreState): void {
    this.#state = {
      ...state,
      canUndo: this.#undoStack.length > 0,
      canRedo: this.#redoStack.length > 0,
    };
    this.#listeners.forEach((listener) => listener());
  }
}

export const projectStore = new ProjectStore();
