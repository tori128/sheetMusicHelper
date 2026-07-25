import type {
  AudioInfo,
  BackendCapability,
  CacheEntry,
  InstrumentDefinition,
  ModelProfile,
  ModelValidationResult,
  PresetDefinition,
  ServiceConnection,
  TempoEstimate,
  TranscriptionJobEvent,
  ProjectDocument,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
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

  get models(): Promise<ModelProfile[]> {
    return this.request("/api/v1/models");
  }

  get backends(): Promise<BackendCapability[]> {
    return this.request("/api/v1/backends");
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

  estimateTempo(path: string): Promise<TempoEstimate> {
    return this.request("/api/v1/tempo/estimate", {
      method: "POST",
      body: JSON.stringify({ path }),
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
        dtype: "float32",
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
    mode: "direct" | "four_stem",
    backend: ModelProfile["defaultBackend"],
  ): Promise<string> {
    const response = await this.request<{ jobId: string }>(
      "/api/v1/jobs/transcribe",
      {
        method: "POST",
        body: JSON.stringify({
          audioPath: project.sourceAudio.absolutePath,
          modelPath: model.modelPath,
          mode,
          backend,
          dtype: "float32",
          tracks: project.tracks,
        }),
      },
    );
    return response.jobId;
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
      const payload = (await response.json()) as { detail?: string };
      detail = payload.detail ?? detail;
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
