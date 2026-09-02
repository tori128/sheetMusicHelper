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

  it("formats validation issues without object string conversion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: [
              {
                loc: ["body", "tracks", 0, "playbackVolume"],
                msg: "Input should be less than or equal to 100",
              },
              {
                loc: ["body", "tracks", 1, "instrumentId"],
                msg: "Field required",
              },
            ],
          }),
          {
            status: 422,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
    });

    await expect(client.models).rejects.toEqual(
      new ApiError(
        [
          "tracks.0.playbackVolume: Input should be less than or equal to 100",
          "tracks.1.instrumentId: Field required",
        ].join("\n"),
        422,
      ),
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

  it("loads external stem model availability", async () => {
    const status = {
      available: false,
      modelDirectory: "D:\\EarCopyAssist\\models\\bs-roformer\\sw-fixed",
      reason: "BS-RoFormer SW Fixedモデルが見つかりません",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(status), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });

    await expect(client.stemSeparation).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/api/v1/stem-separation",
      expect.any(Object),
    );
  });

  it("acknowledges the unknown license before downloading the stem model", async () => {
    const status = {
      available: true,
      modelDirectory: "D:\\EarCopyAssist\\models\\bs-roformer\\sw-fixed",
      modelName: "BS-RoFormer SW Fixed",
      modelFileName: "BS-Rofo-SW-Fixed.ckpt",
      modelSizeBytes: 699_412_152,
      modelSha256: "24e7",
      licenseStatus: "Unknown",
      sourcePageUrl: "https://huggingface.co/example/model",
      reason: "",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(status), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });

    await expect(client.downloadStemSeparationModel(true)).resolves.toEqual(
      status,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/api/v1/stem-separation/model/download",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ licenseStatusAcknowledged: true }),
      }),
    );
  });

  it("sends the time signature when estimating tempo and measure position", async () => {
    const result = {
      bpm: 123.4,
      sampleRate: 22050,
      beatOffsetSec: 0.42,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });

    await expect(client.estimateTempo("D:\\audio.wav", 3, 4)).resolves.toEqual(
      result,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/api/v1/tempo/estimate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          path: "D:\\audio.wav",
          numerator: 3,
          denominator: 4,
        }),
      }),
    );
  });

  it("requests beat-level spectral differences from the local service", async () => {
    const result = {
      intervals: [
        {
          startSec: 0,
          endSec: 0.5,
          measureNumber: 1,
          beatInMeasure: 1,
          value: 0.25,
        },
      ],
      minimum: 0.25,
      maximum: 0.25,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });
    const request = {
      sourcePaths: ["D:\\audio\\source.wav"],
      synthesizedPath: "D:\\cache\\synthesized.wav",
      durationSec: 10,
      timelineOffsetSec: 0,
      bpm: 120,
      beatOffsetSec: 0,
      numerator: 4,
      denominator: 4,
    };

    await expect(client.calculateSpectralDifference(request)).resolves.toEqual(
      result,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/api/v1/audio/spectral-difference",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
  });

  it("registers a local model with automatic backend selection", async () => {
    const profile = {
      id: "model-1",
      profileName: "MuScriptor Small",
      modelPath: "D:\\models\\small\\model.safetensors",
      fileName: "model.safetensors",
      sha256: "hash",
      variant: "small",
      dtype: "float16",
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
      dtype: "float16",
      defaultBackend: "Auto",
    });
  });

  it("uses float32 only for an explicitly selected CPU backend", async () => {
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
      variant: "small",
    } as ModelProfile;

    await expect(
      client.startTranscription(project, model, "direct", "CPU"),
    ).resolves.toBe("job-1");

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual(
      expect.objectContaining({
        backend: "CPU",
        dtype: "float32",
        modelVariant: "small",
        transcriptionProfile: "high_accuracy",
      }),
    );
  });

  it("uses float16 for automatic CUDA-capable transcription", async () => {
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
      variant: "medium",
    } as ModelProfile;

    await client.startTranscription(
      project,
      model,
      "separated",
      "Auto",
      {
        drumOnsetGuide: true,
        timingGuideNoteFilter: true,
        velocityFromStemAmplitude: true,
      },
      "automatic",
      "fast",
      ["bass"],
      "timing_reference_only",
    );

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toEqual(
      expect.objectContaining({
        backend: "Auto",
        modelVariant: "medium",
        mode: "separated",
        transcriptionProfile: "fast",
        instrumentSelectionMode: "automatic",
        drumOnsetGuide: true,
        timingGuideNoteFilter: true,
        velocityFromStemAmplitude: true,
        transcriptionInputNames: ["bass"],
        transcriptionInputPass: "timing_reference_only",
        dtype: "float16",
      }),
    );
    expect(body).not.toHaveProperty("beamSize");
  });

  it("updates velocities through the note postprocessing endpoint", async () => {
    const responseNote = {
      id: "note-1",
      sourceInstrumentId: "acoustic_piano",
      trackId: "track-1",
      pitch: 60,
      rawStartSec: 0,
      rawEndSec: 1,
      startSec: 0,
      endSec: 1,
      velocity: 64,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ notes: [responseNote] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });
    const stem = {
      type: "piano",
      cachePath: "D:\\cache\\piano.wav",
      sha256: "a".repeat(64),
      sampleRate: 44_100,
      channels: 2,
      mute: false,
      solo: false,
    } as const;

    const notes = await client.applyStemAmplitudeVelocitySetting(
      [{ ...responseNote, velocity: 100 }],
      [stem],
      true,
    );

    expect(notes).toEqual([responseNote]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:54321/api/v1/notes/stem-amplitude-velocity",
    );
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      notes: [{ ...responseNote, velocity: 100 }],
      stems: [stem],
      enabled: true,
    });
  });

  it("applies structural options to saved transcription inputs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ notes: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });
    const inputResults = [
      {
        inputName: "other",
        role: "primary" as const,
        transcriptionPass: "drums_added_audio" as const,
        notes: [],
      },
    ];
    const tracks = [
      {
        id: "track-1",
        displayName: "Piano",
        instrumentId: "acoustic_piano",
        color: "#112233",
        kind: "pitched" as const,
        order: 1,
        midiChannel: 1,
        gmProgram: 0,
        playbackOctaveShift: 0 as const,
        playbackVolume: 100,
        mute: false,
        solo: false,
      },
    ];

    await client.applySavedTranscriptionOptions(
      inputResults,
      tracks,
      "fixed",
      {
        drumOnsetGuide: true,
        timingGuideNoteFilter: false,
        velocityFromStemAmplitude: true,
      },
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:54321/api/v1/notes/saved-transcription-options",
    );
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      inputResults,
      tracks,
      instrumentSelectionMode: "fixed",
      timingGuideNoteFilter: false,
    });
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

  it("prepares playback audio and reads binary PCM frames", async () => {
    const frames = new Uint8Array([0, 1, 2, 3]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            path: "D:\\cache\\analysis.wav",
            sampleRate: 44100,
            channels: 2,
            frameCount: 44100,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(frames, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });

    await expect(client.preparePlaybackAudio("D:\\audio.wav")).resolves.toEqual(
      {
        path: "D:\\cache\\analysis.wav",
        sampleRate: 44100,
        channels: 2,
        frameCount: 44100,
      },
    );
    await expect(
      client.readPlaybackAudioFrames({
        sourcePaths: ["D:\\cache\\analysis.wav"],
        startFrame: 22050,
        frameCount: 44100,
      }),
    ).resolves.toEqual(frames.buffer);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({
      sourcePaths: ["D:\\cache\\analysis.wav"],
      startFrame: 22050,
      frameCount: 44100,
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

  it("validates and previews the current score", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ issues: [], errorCount: 0, warningCount: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ xml: "<?xml version=\"1.0\"?><score-partwise/>" }), {
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

    await expect(client.validateScore(project)).resolves.toMatchObject({
      errorCount: 0,
      warningCount: 0,
    });
    await expect(client.previewMusicXml(project)).resolves.toContain(
      "score-partwise",
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:54321/api/v1/export/validate",
      "http://127.0.0.1:54321/api/v1/export/musicxml/preview",
    ]);
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

  it("overwrites a user preset", async () => {
    const preset = {
      id: "preset id",
      key: "user:preset id",
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
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({
      baseUrl: "http://127.0.0.1:54321",
      token: "local-secret",
    });

    await expect(
      client.overwritePreset(preset.id, preset.name, preset.tracks),
    ).resolves.toEqual(preset);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/api/v1/presets/preset%20id",
      expect.objectContaining({ method: "PUT" }),
    );
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      name: "My Band",
      tracks: preset.tracks,
    });
  });

  it("deletes a user preset", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
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

    await expect(client.deletePreset("preset id")).resolves.toEqual({
      deleted: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/api/v1/presets/preset%20id",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
