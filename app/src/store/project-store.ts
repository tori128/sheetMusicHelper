import type {
  AudioInfo,
  InstrumentDefinition,
  InferenceBackend,
  ModelProfile,
  PresetDefinition,
  ProjectDocument,
  ProjectNote,
  QuantizeGrid,
  TranscriptionJobEvent,
  TranscriptionJobStatus,
} from "../types";
import { quantizeNotes, reassignNotes, shiftNotes } from "./project-editing";

const PITCHED_CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16];

export interface ProjectStoreState {
  screen: "new-project" | "editor";
  project: ProjectDocument | null;
  model: ModelProfile | null;
  presetId: string | null;
  transcriptionMode: "direct" | "four_stem";
  inferenceBackend: InferenceBackend;
  job: {
    id: string;
    status: TranscriptionJobStatus;
    completed: number;
    total: number;
    error: string | null;
  } | null;
  selectedNoteIds: ReadonlySet<string>;
}

export interface CreateProjectInput {
  name: string;
  audio: AudioInfo;
  bpm: number;
  beatOffsetSec?: number;
  numerator: number;
  denominator: 2 | 4 | 8 | 16;
  preset: PresetDefinition;
  instruments: InstrumentDefinition[];
  model?: ModelProfile | null;
  mode?: "direct" | "four_stem";
  backend?: InferenceBackend;
}

type Listener = () => void;

export class ProjectStore {
  #state: ProjectStoreState = {
    screen: "new-project",
    project: null,
    model: null,
    presetId: null,
    transcriptionMode: "direct",
    inferenceBackend: "Auto",
    job: null,
    selectedNoteIds: new Set(),
  };
  #listeners = new Set<Listener>();

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
    let pitchedChannelIndex = 0;
    const tracks = input.preset.tracks.map((definition) => {
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
      return {
        ...definition,
        id: this.idFactory(),
        midiChannel,
        gmProgram: instrument.gmProgram,
        mute: false,
        solo: false,
      };
    });
    this.#setState({
      screen: "editor",
      model: input.model ?? null,
      presetId: input.preset.id,
      transcriptionMode: input.mode ?? "direct",
      inferenceBackend: input.backend ?? input.model?.defaultBackend ?? "Auto",
      job: null,
      selectedNoteIds: new Set(),
      project: {
        formatVersion: 1,
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
    if (project.formatVersion !== 1) {
      throw new Error(
        `未対応のプロジェクト形式です: ${project.formatVersion}`,
      );
    }
    const knownTrackIds = new Set(project.tracks.map((track) => track.id));
    if (project.notes.some((note) => !knownTrackIds.has(note.trackId))) {
      throw new Error("存在しないトラックを参照するノートがあります");
    }
    this.#setState({
      screen: "editor",
      project: {
        ...project,
        notes: [...project.notes].sort(
          (left, right) =>
            left.startSec - right.startSec ||
            left.pitch - right.pitch ||
            left.id.localeCompare(right.id),
        ),
      },
      model,
      presetId: project.transcription?.presetId ?? null,
      transcriptionMode: project.transcription?.mode ?? "direct",
      inferenceBackend:
        project.transcription?.backend ?? model?.defaultBackend ?? "Auto",
      job: project.transcription
        ? {
            id: "",
            status: "completed",
            completed: 0,
            total: 0,
            error: null,
          }
        : null,
      selectedNoteIds: new Set(),
    });
  }

  toggleMute(trackId: string): void {
    this.#updateTrack(trackId, (track) => ({ ...track, mute: !track.mute }));
  }

  toggleSolo(trackId: string): void {
    this.#updateTrack(trackId, (track) => ({ ...track, solo: !track.solo }));
  }

  setBpm(bpm: number): void {
    if (bpm < 20 || bpm > 300) {
      throw new Error("BPMは20.0〜300.0で指定してください");
    }
    const project = this.#requireProject();
    this.#setState({
      ...this.#state,
      project: {
        ...project,
        tempo: { ...project.tempo, bpm },
      },
    });
  }

  setTempoAnalysis(bpm: number, beatOffsetSec: number): void {
    if (bpm < 20 || bpm > 300) {
      throw new Error("BPMは20.0〜300.0で指定してください");
    }
    if (!Number.isFinite(beatOffsetSec) || beatOffsetSec < 0) {
      throw new Error("拍位置が不正です");
    }
    const project = this.#requireProject();
    this.#setState({
      ...this.#state,
      project: {
        ...project,
        tempo: { ...project.tempo, bpm, beatOffsetSec },
      },
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
    this.#setState({
      ...this.#state,
      project: {
        ...project,
        tempo: { ...project.tempo, beatOffsetSec },
      },
    });
  }

  beginJob(jobId: string): void {
    this.#requireProject();
    this.#setState({
      ...this.#state,
      job: {
        id: jobId,
        status: "waiting",
        completed: 0,
        total: 0,
        error: null,
      },
    });
  }

  applyJobEvent(event: TranscriptionJobEvent): void {
    if (this.#state.job === null) {
      throw new Error("採譜ジョブが開始されていません");
    }
    if (event.type === "state") {
      const project = this.#state.project;
      const transcription =
        event.status === "completed" &&
        project !== null &&
        this.#state.model !== null &&
        this.#state.presetId !== null
          ? {
              mode: this.#state.transcriptionMode,
              presetId: this.#state.presetId,
              modelProfileId: this.#state.model.id,
              modelSha256: this.#state.model.sha256,
              backend:
                event.backend ??
                (this.#state.inferenceBackend === "Auto"
                  ? ("CPU" as const)
                  : this.#state.inferenceBackend),
              completedAt: new Date().toISOString(),
            }
          : project?.transcription ?? null;
      this.#setState({
        ...this.#state,
        job: { ...this.#state.job, status: event.status },
        project:
          project === null ? null : { ...project, transcription },
      });
      return;
    }
    if (event.type === "progress") {
      this.#setState({
        ...this.#state,
        job: {
          ...this.#state.job,
          status: "transcribing",
          completed: event.completed,
          total: event.total,
        },
      });
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
      const project = this.#requireProject();
      this.#setState({
        ...this.#state,
        project: {
          ...project,
          stems: [
            ...project.stems.filter(
              (stem) => stem.type !== event.stem.type,
            ),
            event.stem,
          ],
        },
      });
      return;
    }
    const { type: _type, ...note } = event;
    this.#upsertNote(note);
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
      },
    });
  }

  setSelection(noteIds: Iterable<string>): void {
    const project = this.#requireProject();
    const knownIds = new Set(project.notes.map((note) => note.id));
    const selection = new Set(
      [...noteIds].filter((noteId) => knownIds.has(noteId)),
    );
    this.#setState({ ...this.#state, selectedNoteIds: selection });
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
    this.#setState({
      ...this.#state,
      project: { ...project, notes: result.notes },
      selectedNoteIds: result.selectedIds,
    });
  }

  quantizeAll(grid: QuantizeGrid): void {
    const project = this.#requireProject();
    this.#setState({
      ...this.#state,
      project: {
        ...project,
        tempo: { ...project.tempo, quantizeGrid: grid },
        notes: quantizeNotes(
          project.notes,
          project.tempo.bpm,
          grid,
          project.tempo.beatOffsetSec ?? 0,
        ),
      },
    });
  }

  shiftAllNotes(offsetSec: number): void {
    const project = this.#requireProject();
    this.#setState({
      ...this.#state,
      project: {
        ...project,
        notes: shiftNotes(project.notes, offsetSec),
      },
    });
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
    this.#setState({
      screen: "new-project",
      project: null,
      model: null,
      presetId: null,
      transcriptionMode: "direct",
      inferenceBackend: "Auto",
      job: null,
      selectedNoteIds: new Set(),
    });
  }

  #upsertNote(note: ProjectNote): void {
    const project = this.#requireProject();
    if (!project.tracks.some((track) => track.id === note.trackId)) {
      throw new Error(`ノートのトラックが見つかりません: ${note.trackId}`);
    }
    const notes = project.notes.filter((existing) => existing.id !== note.id);
    notes.push(note);
    notes.sort(
      (left, right) =>
        left.startSec - right.startSec ||
        left.pitch - right.pitch ||
        left.id.localeCompare(right.id),
    );
    this.#setState({
      ...this.#state,
      project: { ...project, notes },
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

  #setState(state: ProjectStoreState): void {
    this.#state = state;
    this.#listeners.forEach((listener) => listener());
  }
}

export const projectStore = new ProjectStore();
