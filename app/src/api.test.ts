import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, LocalApiClient, parseSseStream } from "./api";
import type { ModelProfile, ProjectDocument } from "./types";

describe("LocalApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the session token only to the configured loopback service", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "drums" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });

    await client.instruments;

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/api/v1/instruments",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer local-secret",
        }),
      }),
    );
  });

  it("surfaces API error details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "モデルが見つかりません" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
    });

    await expect(client.models).rejects.toEqual(
      new ApiError("モデルが見つかりません", 400),
    );
  });

  it("loads all local inference backend choices", async () => {
    const backends = [
      { id: "Auto", available: true, reason: "CPUを自動選択" },
      { id: "CPU", available: true, reason: "PyTorch CPU" },
      { id: "CUDA", available: false, reason: "CUDA配布版が必要" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(backends), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });

    await expect(client.backends).resolves.toEqual(backends);
  });

  it("registers a local model with automatic backend selection", async () => {
    const profile = {
      id: "model-1",
      profileName: "MuScriptor Small",
      modelPath: "D:\\models\\small\\model.safetensors",
      fileName: "model.safetensors",
      sha256: "hash",
      variant: "small",
      dtype: "float32",
      defaultBackend: "Auto",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(profile), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });

    await expect(
      client.registerModel(profile.modelPath, profile.profileName),
    ).resolves.toEqual(profile);

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      profileName: "MuScriptor Small",
      path: "D:\\models\\small\\model.safetensors",
      dtype: "float32",
      defaultBackend: "Auto",
    });
  });

  it("passes the selected inference backend to the local job", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jobId: "job-1" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });
    const project = {
      sourceAudio: { absolutePath: "D:\\audio.wav" },
      tracks: [{ id: "track-1" }],
    } as ProjectDocument;
    const model = {
      modelPath: "D:\\model.safetensors",
    } as ModelProfile;

    await expect(
      client.startTranscription(project, model, "direct", "CPU"),
    ).resolves.toBe("job-1");

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual(
      expect.objectContaining({ backend: "CPU" }),
    );
  });

  it("lists and deletes only a selected local cache entry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "audio/analysis.wav",
              sizeBytes: 12,
              modifiedAt: "2026-07-26T00:00:00Z",
              kind: "audio",
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });

    await expect(client.cacheEntries).resolves.toHaveLength(1);
    await expect(
      client.deleteCacheEntry("audio/analysis.wav"),
    ).resolves.toEqual({ deleted: true });

    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      entryId: "audio/analysis.wav",
    });
  });

  it("refuses every non-loopback service URL", () => {
    expect(
      () =>
        new LocalApiClient({
          baseUrl: "https://api.example.com",
          token: "must-not-leak",
        }),
    ).toThrow("localhostまたは127.0.0.1");
  });

  it("parses chunked SSE events and ignores keep-alives", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            ': keep-alive\n\nid: 1\ndata: {"type":"progress","stage":"trans',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'cribing","completed":1,"total":2}\n\nid: 2\ndata: {"type":"state","status":"completed"}\n\n',
          ),
        );
        controller.close();
      },
    });
    const events: unknown[] = [];

    await parseSseStream(stream, (event) => events.push(event));

    expect(events).toEqual([
      {
        type: "progress",
        stage: "transcribing",
        completed: 1,
        total: 2,
      },
      { type: "state", status: "completed" },
    ]);
  });

  it("exports the current project to a local MIDI path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ path: "D:\\exports\\song.mid" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });
    const project = { name: "song" } as ProjectDocument;

    await expect(
      client.exportMidi(project, "D:\\exports\\song.mid"),
    ).resolves.toBe("D:\\exports\\song.mid");

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      project,
      outputPath: "D:\\exports\\song.mid",
    });
  });

  it("exports the current project to a local MusicXML path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ path: "D:\\exports\\song.musicxml" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });
    const project = { name: "song" } as ProjectDocument;

    await expect(
      client.exportMusicXml(project, "D:\\exports\\song.musicxml"),
    ).resolves.toBe("D:\\exports\\song.musicxml");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/api/v1/export/musicxml",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("exports four cached stems to a selected directory", async () => {
    const paths = [
      "D:\\exports\\song_drums.wav",
      "D:\\exports\\song_bass.wav",
      "D:\\exports\\song_vocals.wav",
      "D:\\exports\\song_other.wav",
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ paths }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });
    const project = { name: "song" } as ProjectDocument;

    await expect(
      client.exportStems(project, "D:\\exports"),
    ).resolves.toEqual(paths);

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      project,
      outputDirectory: "D:\\exports",
    });
  });

  it("saves a copied user preset", async () => {
    const preset = {
      id: "preset-id",
      key: "user:preset-id",
      name: "My Band",
      trackCount: 1,
      tracks: [
        {
          displayName: "Piano",
          instrumentId: "acoustic_piano",
          color: "#112233",
          kind: "pitched" as const,
          order: 1,
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(preset), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });

    await expect(
      client.savePreset(preset.name, preset.tracks),
    ).resolves.toEqual(preset);

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      name: "My Band",
      tracks: preset.tracks,
    });
  });
});
