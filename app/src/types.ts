export type TrackKind = "pitched" | "drums";
export type StemType =
  | "drums"
  | "bass"
  | "vocals"
  | "piano"
  | "guitar"
  | "other";
export type ModelVariant = "small" | "medium" | "large";
export type InferenceBackend = "Auto" | "CPU" | "CUDA";
export type InstrumentSelectionMode = "fixed" | "automatic";
export type TranscriptionProfile = "high_accuracy" | "fast";
export interface BackendCapability {
  id: InferenceBackend;
  available: boolean;
  reason: string;
}

export interface StemSeparationCapability {
  available: boolean;
  modelDirectory: string;
  modelName: string;
  modelFileName: string;
  modelSizeBytes: number;
  modelSha256: string;
  licenseStatus: "Unknown";
  sourcePageUrl: string;
  reason: string;
}

export interface CacheEntry {
  id: string;
  sizeBytes: number;
  modifiedAt: string;
  kind: string;
}
export type QuantizeGrid =
  | "1/4"
  | "1/8"
  | "1/16"
  | "1/32"
  | "1/8T"
  | "1/16T";

export interface ServiceConnection {
  baseUrl: string;
  token: string;
}

export interface DesktopApi {
  quitApplication(): Promise<void>;
  getServiceConnection(): Promise<ServiceConnection>;
  getAboutInfo(): Promise<AppAboutInfo>;
  getLocalAudioUrl(path: string): Promise<string>;
  loadSoundFont(): Promise<Uint8Array>;
  writeSpectralAnalysisAudio(bytes: Uint8Array): Promise<string>;
  deleteSpectralAnalysisAudio(path: string): Promise<void>;
  selectAudioFile(): Promise<string | null>;
  getPathForDroppedFile(file: File): string;
  selectModelFile(): Promise<string | null>;
  selectProjectFile(): Promise<string | null>;
  selectExportPath(kind: "midi" | "musicxml"): Promise<string | null>;
  selectExportDirectory(): Promise<string | null>;
  showItemInFolder(path: string): Promise<void>;
  saveProjectFile(defaultName: string, json: string): Promise<string | null>;
}

export interface LicenseNotice {
  name: string;
  text: string;
}

export interface AppAboutInfo {
  appVersion: string;
  engineVersion: string;
  notices: LicenseNotice[];
}

export interface InstrumentDefinition {
  id: string;
  displayNameJa: string;
  kind: TrackKind;
  gmProgram: number | null;
  gmPrograms: GmProgramDefinition[];
}

export interface GmProgramDefinition {
  program: number;
  displayNameJa: string;
}

export interface PresetTrackDefinition {
  displayName: string;
  instrumentId: string;
  color: string;
  kind: TrackKind;
  order: number;
  gmProgram?: number | null;
}

export interface PresetDefinition {
  id: string;
  key: string;
  name: string;
  trackCount: number;
  tracks: PresetTrackDefinition[];
}

export interface ModelProfile {
  id: string;
  profileName: string;
  modelPath: string;
  fileName: string;
  sha256: string;
  variant: ModelVariant;
  dtype: "float32" | "float16";
  defaultBackend: InferenceBackend;
}

export interface ModelValidationResult {
  fileName: string;
  sha256: string;
  sizeBytes: number;
  estimatedMemoryBytes: number;
  validContainer: boolean;
  loadable: boolean;
  tensorCount: number;
  dtypes: string[];
  variant: ModelVariant | null;
  configPath: string | null;
  errors: string[];
  warnings: string[];
}

export interface AudioInfo {
  absolutePath: string;
  sha256: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  codecName: string;
}

export interface PlaybackAudioInfo {
  path: string;
  sampleRate: 44100;
  channels: 2;
  frameCount: number;
}

export interface TempoEstimate {
  bpm: number;
  sampleRate: number;
  beatOffsetSec: number;
}

export type TranscriptionJobStatus =
  | "waiting"
  | "preparing_audio"
  | "separating"
  | "loading_model"
  | "transcribing"
  | "building_project"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobStateEvent {
  type: "state";
  status: TranscriptionJobStatus;
  backend?: "CPU" | "CUDA";
}

export interface JobSeparationProgressEvent {
  type: "progress";
  stage: "separating";
  completed: number;
  total: number;
}

export type TranscriptionPass =
  | "original_audio"
  | "separated_audio"
  | "drums_added_audio"
  | "other_added_audio";

export type TranscriptionInputResultRole =
  | "primary"
  | "timing_reference";

export interface JobTranscriptionProgressEvent {
  type: "progress";
  stage: "transcribing";
  completed: number;
  total: number;
  transcriptionInputName: string;
  transcriptionPass: TranscriptionPass;
  inputPassIndex: number;
  inputPassCount: number;
}

export type JobProgressEvent =
  | JobSeparationProgressEvent
  | JobTranscriptionProgressEvent;

export interface JobPartialResultEvent {
  type: "partial_result";
  inputName: string;
  completedInputs: number;
  totalInputs: number;
  completedPasses: number;
  totalPasses: number;
  noteCount: number;
  assembledNoteCount?: number;
  invalidChunkCount?: number;
  invalidChunkDiscardedNoteCount?: number;
  audioTailDiscardedNoteCount?: number;
  audioTailTruncatedNoteCount?: number;
  pathologicalChainCount?: number;
  pathologicalChainDiscardedNoteCount?: number;
  mappedDuplicateDiscardedNoteCount?: number;
  timingGuideUnmodifiedNoteCount?: number | null;
  timingGuideNoteDiscardedCount?: number;
  timingGuideNoteMergedCount?: number;
  timingGuideFilterCacheHit?: boolean | null;
}

export interface JobNoteEvent extends ProjectNote {
  type: "note";
}

export interface JobNoteCleanupEvent {
  type: "note_cleanup";
  removedNoteIds: string[];
}

export interface ProjectTranscriptionInputResult {
  inputName: string;
  role: TranscriptionInputResultRole;
  transcriptionPass: TranscriptionPass;
  notes: ProjectNote[];
}

export interface JobTranscriptionInputResultEvent
  extends ProjectTranscriptionInputResult {
  type: "transcription_input_result";
}

export interface JobTrackEvent {
  type: "track";
  track: ProjectTrack;
}

export interface JobErrorEvent {
  type: "error";
  message: string;
  exceptionType: string;
}

export interface ProjectStem {
  type: StemType;
  cachePath: string;
  sha256: string;
  sampleRate: 44100;
  channels: 2;
  mute: boolean;
  solo: boolean;
}

export interface JobStemEvent {
  type: "stem";
  stem: ProjectStem;
}

export type TranscriptionJobEvent =
  | JobStateEvent
  | JobProgressEvent
  | JobPartialResultEvent
  | JobTrackEvent
  | JobNoteEvent
  | JobNoteCleanupEvent
  | JobTranscriptionInputResultEvent
  | JobStemEvent
  | JobErrorEvent;

export interface ProjectTrack extends PresetTrackDefinition {
  id: string;
  midiChannel: number;
  gmProgram: number | null;
  playbackOctaveShift: 0 | 1;
  playbackVolume: number;
  mute: boolean;
  solo: boolean;
}

export interface ProjectNote {
  id: string;
  sourceInstrumentId: string;
  trackId: string;
  pitch: number;
  rawStartSec: number;
  rawEndSec: number;
  startSec: number;
  endSec: number;
  velocity: number;
}

export interface ScoreChord {
  startSec: number;
  endSec: number;
  label: string;
}

export interface ScoreTrackSettings {
  clef:
    | "auto"
    | "treble"
    | "alto"
    | "tenor"
    | "bass"
    | "percussion"
    | "grand";
  transpositionSemitones: number;
}

export interface ScoreSettings {
  composer: string;
  arranger: string;
  copyright: string;
  keyFifths: number;
  keyMode: "major" | "minor";
  pickupTicks: number;
  includeChordSymbols: boolean;
  chords: ScoreChord[];
  trackSettings: Record<string, ScoreTrackSettings>;
}

export interface ScoreValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  trackId: string | null;
  noteIds: string[];
  timeSec: number;
  measureNumber: number;
  beatNumber: number;
}

export interface ScoreValidationResult {
  issues: ScoreValidationIssue[];
  errorCount: number;
  warningCount: number;
}

export interface SeparatedTranscriptionSettings {
  drumOnsetGuide: boolean;
  timingGuideNoteFilter: boolean;
  velocityFromStemAmplitude: boolean;
}

export interface ProjectDocument {
  formatVersion: 5;
  appVersion: string;
  projectId: string;
  name: string;
  sourceAudio: {
    absolutePath: string;
    relativePath: string;
    sha256: string;
    durationSec: number;
    sampleRate: number;
    channels: number;
    timelineOffsetSec: number;
  };
  tempo: {
    bpm: number;
    beatOffsetSec: number;
    timeSignature: {
      numerator: number;
      denominator: 2 | 4 | 8 | 16;
    };
    ppq: 480;
    quantizeGrid: QuantizeGrid;
  };
  transcription: {
    mode: "direct" | "separated";
    transcriptionProfile: TranscriptionProfile;
    instrumentSelectionMode: InstrumentSelectionMode;
    drumOnsetGuide: boolean;
    timingGuideNoteFilter: boolean;
    velocityFromStemAmplitude: boolean;
    presetId: string | null;
    modelProfileId: string;
    modelSha256: string;
    backend: "CPU" | "CUDA";
    completedAt: string;
    inputResults: ProjectTranscriptionInputResult[];
  } | null;
  tracks: ProjectTrack[];
  notes: ProjectNote[];
  stems: ProjectStem[];
  score: ScoreSettings;
  viewState: {
    activeRoll: "pitched" | "drums";
    horizontalZoom: number;
    verticalZoom: number;
    scrollTimeSec: number;
  };
}

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}
