import type {
  AudioInfo,
  PlaybackAudioInfo,
  BackendCapability,
  CacheEntry,
  InstrumentDefinition,
  SeparatedTranscriptionSettings,
  InstrumentSelectionMode,
  ModelProfile,
  ModelValidationResult,
  PresetDefinition,
  ServiceConnection,
  StemSeparationCapability,
  StemType,
  TempoEstimate,
  TranscriptionProfile,
  TranscriptionJobEvent,
  ProjectDocument,
  ProjectNote,
  ProjectStem,
  ProjectTrack,
  ProjectTranscriptionInputResult,
  ScoreValidationResult,
} from "./types";
import type {
  SpectralDifferenceRequest,
  SpectralDifferenceResult,
} from "./spectral-difference";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface ApiValidationIssue {
  loc?: unknown[];
  msg?: unknown;
}

function apiErrorDetail(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail.length > 0) {
    return detail;
  }
  if (Array.isArray(detail)) {
    const issues = detail
      .map((item) => {
        if (typeof item !== "object" || item === null) {
          return null;
        }
        const issue = item as ApiValidationIssue;
        const location = Array.isArray(issue.loc)
          ? issue.loc
              .filter((part) => part !== "body")
              .map(String)
              .join(".")
          : "";
        const message = typeof issue.msg === "string" ? issue.msg : "入力値が不正です";
        return location ? `${location}: ${message}` : message;
      })
      .filter((issue): issue is string => issue !== null);
    if (issues.length > 0) {
      return issues.join("\n");
    }
  }
  return fallback;
}

function utf8JsonBody(value: unknown): ArrayBuffer {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const body = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(body).set(encoded);
  return body;
}

export class LocalApiClient {
  constructor(private readonly connection: ServiceConnection) {
    const url = new URL(connection.baseUrl);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    ) {
      throw new Error(
        "ローカルAPIはlocalhostまたは127.0.0.1にのみ接続できます",
      );
    }
  }

  get instruments(): Promise<InstrumentDefinition[]> {
    return this.request("/api/v1/instruments");
  }

  get presets(): Promise<PresetDefinition[]> {
    return this.request("/api/v1/presets");
  }

  savePreset(
    name: string,
    tracks: PresetDefinition["tracks"],
  ): Promise<PresetDefinition> {
    return this.request("/api/v1/presets", {
      method: "POST",
      body: JSON.stringify({ name, tracks }),
    });
  }

  overwritePreset(
    presetId: string,
    name: string,
    tracks: PresetDefinition["tracks"],
  ): Promise<PresetDefinition> {
    return this.request(`/api/v1/presets/${encodeURIComponent(presetId)}`, {
      method: "PUT",
      body: JSON.stringify({ name, tracks }),
    });
  }

  deletePreset(presetId: string): Promise<{ deleted: boolean }> {
    return this.request(`/api/v1/presets/${encodeURIComponent(presetId)}`, {
      method: "DELETE",
    });
  }

  get models(): Promise<ModelProfile[]> {
    return this.request("/api/v1/models");
  }

  get backends(): Promise<BackendCapability[]> {
    return this.request("/api/v1/backends");
  }

  get stemSeparation(): Promise<StemSeparationCapability> {
    return this.request("/api/v1/stem-separation");
  }

  downloadStemSeparationModel(
    licenseStatusAcknowledged: boolean,
  ): Promise<StemSeparationCapability> {
    return this.request("/api/v1/stem-separation/model/download", {
      method: "POST",
      body: JSON.stringify({ licenseStatusAcknowledged }),
    });
  }

  get cacheEntries(): Promise<CacheEntry[]> {
    return this.request("/api/v1/cache");
  }

  deleteCacheEntry(entryId: string): Promise<{ deleted: boolean }> {
    return this.request("/api/v1/cache/delete", {
      method: "POST",
      body: JSON.stringify({ entryId }),
    });
  }

  inspectAudio(path: string): Promise<AudioInfo> {
    return this.request("/api/v1/audio/inspect", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  preparePlaybackAudio(path: string): Promise<PlaybackAudioInfo> {
    return this.request("/api/v1/audio/playback/prepare", {
      method: "POST",
      body: utf8JsonBody({ path }),
    });
  }

  async readPlaybackAudioFrames(request: {
    sourcePaths: readonly string[];
    startFrame: number;
    frameCount: number;
  }): Promise<ArrayBuffer> {
    const response = await fetch(
      `${this.connection.baseUrl}/api/v1/audio/playback/frames`,
      {
        method: "POST",
        headers: this.headers(true),
        body: utf8JsonBody(request),
      },
    );
    if (!response.ok) {
      throw await this.responseError(response);
    }
    return response.arrayBuffer();
  }

  estimateTempo(
    path: string,
    numerator: number,
    denominator: 2 | 4 | 8 | 16,
  ): Promise<TempoEstimate> {
    return this.request("/api/v1/tempo/estimate", {
      method: "POST",
      body: JSON.stringify({ path, numerator, denominator }),
    });
  }

  calculateSpectralDifference(
    request: SpectralDifferenceRequest,
  ): Promise<SpectralDifferenceResult> {
    return this.request("/api/v1/audio/spectral-difference", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  loadProject(path: string): Promise<ProjectDocument> {
    return this.request("/api/v1/projects/load", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  validateModel(path: string): Promise<ModelValidationResult> {
    return this.request("/api/v1/models/validate", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  registerModel(path: string, profileName: string): Promise<ModelProfile> {
    return this.request("/api/v1/models/register", {
      method: "POST",
      body: JSON.stringify({
        profileName,
        path,
        dtype: "float16",
        defaultBackend: "Auto",
      }),
    });
  }

  exportMidi(project: ProjectDocument, outputPath: string): Promise<string> {
    return this.request<{ path: string }>("/api/v1/export/midi", {
      method: "POST",
      body: JSON.stringify({ project, outputPath }),
    }).then((result) => result.path);
  }

  validateScore(project: ProjectDocument): Promise<ScoreValidationResult> {
    return this.request("/api/v1/export/validate", {
      method: "POST",
      body: JSON.stringify({ project }),
    });
  }

  previewMusicXml(project: ProjectDocument): Promise<string> {
    return this.request<{ xml: string }>("/api/v1/export/musicxml/preview", {
      method: "POST",
      body: JSON.stringify({ project }),
    }).then((result) => result.xml);
  }

  exportMusicXml(
    project: ProjectDocument,
    outputPath: string,
  ): Promise<string> {
    return this.request<{ path: string }>("/api/v1/export/musicxml", {
      method: "POST",
      body: JSON.stringify({ project, outputPath }),
    }).then((result) => result.path);
  }

  exportStems(
    project: ProjectDocument,
    outputDirectory: string,
  ): Promise<string[]> {
    return this.request<{ paths: string[] }>("/api/v1/export/stems", {
      method: "POST",
      body: JSON.stringify({ project, outputDirectory }),
    }).then((result) => result.paths);
  }

  async startTranscription(
    project: ProjectDocument,
    model: ModelProfile,
    mode: "direct" | "separated",
    backend: ModelProfile["defaultBackend"],
    separatedSettings: SeparatedTranscriptionSettings = {
      drumOnsetGuide: true,
      timingGuideNoteFilter: true,
      velocityFromStemAmplitude: true,
    },
    instrumentSelectionMode: InstrumentSelectionMode = "fixed",
    transcriptionProfile: TranscriptionProfile = "high_accuracy",
    transcriptionInputNames: readonly StemType[] | null = null,
    transcriptionInputPass: "all" | "timing_reference_only" = "all",
  ): Promise<string> {
    const response = await this.request<{ jobId: string }>(
      "/api/v1/jobs/transcribe",
      {
        method: "POST",
        body: JSON.stringify({
          audioPath: project.sourceAudio.absolutePath,
          modelPath: model.modelPath,
          modelVariant: model.variant,
          mode,
          transcriptionProfile,
          instrumentSelectionMode,
          backend,
          drumOnsetGuide: separatedSettings.drumOnsetGuide,
          timingGuideNoteFilter:
            separatedSettings.timingGuideNoteFilter,
          velocityFromStemAmplitude:
            separatedSettings.velocityFromStemAmplitude,
          ...(transcriptionInputNames === null
            ? {}
            : { transcriptionInputNames }),
          ...(transcriptionInputPass === "all"
            ? {}
            : { transcriptionInputPass }),
          dtype: backend === "CPU" ? "float32" : "float16",
          tracks: project.tracks,
        }),
      },
    );
    return response.jobId;
  }

  applyStemAmplitudeVelocitySetting(
    notes: readonly ProjectNote[],
    stems: readonly ProjectStem[],
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<ProjectNote[]> {
    return this.request<{ notes: ProjectNote[] }>(
      "/api/v1/notes/stem-amplitude-velocity",
      {
        method: "POST",
        body: JSON.stringify({ notes, stems, enabled }),
        signal,
      },
    ).then((response) => response.notes);
  }

  applySavedTranscriptionOptions(
    inputResults: readonly ProjectTranscriptionInputResult[],
    tracks: readonly ProjectTrack[],
    instrumentSelectionMode: InstrumentSelectionMode,
    settings: SeparatedTranscriptionSettings,
    signal?: AbortSignal,
  ): Promise<ProjectNote[]> {
    return this.request<{ notes: ProjectNote[] }>(
      "/api/v1/notes/saved-transcription-options",
      {
        method: "POST",
        body: JSON.stringify({
          inputResults,
          tracks,
          instrumentSelectionMode,
          timingGuideNoteFilter: settings.timingGuideNoteFilter,
        }),
        signal,
      },
    ).then((response) => response.notes);
  }

  cancelTranscription(jobId: string): Promise<{
    jobId: string;
    status: string;
  }> {
    return this.request(`/api/v1/jobs/${jobId}/cancel`, { method: "POST" });
  }

  async streamJobEvents(
    jobId: string,
    onEvent: (event: TranscriptionJobEvent) => void,
    signal?: AbortSignal,
    afterSequence = 0,
  ): Promise<void> {
    const response = await fetch(
      `${this.connection.baseUrl}/api/v1/jobs/${jobId}/events?after=${afterSequence}`,
      {
        headers: this.headers(false),
        signal,
      },
    );
    if (!response.ok) {
      throw await this.responseError(response);
    }
    if (response.body === null) {
      throw new ApiError("SSEレスポンスにbodyがありません", response.status);
    }
    await parseSseStream(response.body, onEvent);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.connection.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers(Boolean(init.body)),
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw await this.responseError(response);
    }
    return (await response.json()) as T;
  }

  private headers(hasBody: boolean): Record<string, string> {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${this.connection.token}`,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    };
  }

  private async responseError(response: Response): Promise<ApiError> {
    let detail = `ローカルAPIエラー (${response.status})`;
    try {
      const payload = (await response.json()) as { detail?: unknown };
      detail = apiErrorDetail(payload.detail, detail);
    } catch {
      // JSONではないエラー応答には共通メッセージを使用する。
    }
    return new ApiError(detail, response.status);
  }
}

export async function parseSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: TranscriptionJobEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        onEvent(JSON.parse(data) as TranscriptionJobEvent);
      }
    }
    if (done) {
      break;
    }
  }
  const trailingData = buffer
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (trailingData) {
    onEvent(JSON.parse(trailingData) as TranscriptionJobEvent);
  }
}
