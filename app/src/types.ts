export type TrackKind = "pitched" | "drums";
export type ModelVariant = "small" | "medium" | "large";
export type InferenceBackend = "Auto" | "CPU" | "CUDA";
export interface BackendCapability {
  id: InferenceBackend;
  available: boolean;
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
  getServiceConnection(): Promise<ServiceConnection>;
  getAboutInfo(): Promise<AppAboutInfo>;
  getLocalAudioUrl(path: string): Promise<string>;
  loadSoundFont(): Promise<Uint8Array>;
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
}

export interface PresetTrackDefinition {
  displayName: string;
  instrumentId: string;
  color: string;
  kind: TrackKind;
  order: number;
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

export interface JobProgressEvent {
  type: "progress";
  stage: "transcribing";
  completed: number;
  total: number;
}

export interface JobNoteEvent extends ProjectNote {
  type: "note";
}

export interface JobErrorEvent {
  type: "error";
  message: string;
  exceptionType: string;
}

export interface ProjectStem {
  type: "drums" | "bass" | "vocals" | "other";
  cachePath: string;
  sha256: string;
  sampleRate: 44100;
  channels: 2;
}

export interface JobStemEvent {
  type: "stem";
  stem: ProjectStem;
}

export type TranscriptionJobEvent =
  | JobStateEvent
  | JobProgressEvent
  | JobNoteEvent
  | JobStemEvent
  | JobErrorEvent;

export interface ProjectTrack extends PresetTrackDefinition {
  id: string;
  midiChannel: number;
  gmProgram: number | null;
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

export interface ProjectDocument {
  formatVersion: 1;
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
  };
  tempo: {
    bpm: number;
    beatOffsetSec?: number;
    timeSignature: {
      numerator: number;
      denominator: 2 | 4 | 8 | 16;
    };
    ppq: 480;
    quantizeGrid: QuantizeGrid;
  };
  transcription: {
    mode: "direct" | "four_stem";
    presetId: string;
    modelProfileId: string;
    modelSha256: string;
    backend: "CPU" | "CUDA";
    completedAt: string;
  } | null;
  tracks: ProjectTrack[];
  notes: ProjectNote[];
  stems: ProjectStem[];
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
