import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalApiClient } from "./api";
import { PcmSourcePlayback } from "./pcm-source-playback";
import type { PlaybackAudioOutputGraph } from "./playback-audio-output";
import type { ProjectStem, StemType } from "./types";

function audioParam(initialValue = 0) {
  return {
    value: initialValue,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
}

function gainNode() {
  return {
    gain: audioParam(),
    channelCount: 2,
    channelCountMode: "max" as ChannelCountMode,
    channelInterpretation: "speakers" as ChannelInterpretation,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function stem(type: StemType, mute = false, solo = false): ProjectStem {
  return {
    type,
    cachePath: `${type}.wav`,
    sha256: "a".repeat(64),
    sampleRate: 44_100,
    channels: 2,
    mute,
    solo,
  };
}

function createGraph(sampleRate = 44_100) {
  const delay = {
    delayTime: audioParam(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const gains = [gainNode(), gainNode(), gainNode()];
  const panner = {
    pan: audioParam(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const context = {
    sampleRate,
    currentTime: 3,
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    createDelay: vi.fn(() => delay),
    createGain: vi.fn(() => gains.shift()!),
    createStereoPanner: vi.fn(() => panner),
  };
  const graph = {
    context: context as unknown as AudioContext,
    destination: { id: "destination" } as unknown as AudioNode,
    start: vi.fn().mockResolvedValue(undefined),
    setOutputDevice: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  } satisfies PlaybackAudioOutputGraph;
  return { context, graph, delay };
}

class AudioWorkletNodeMock {
  static instances: AudioWorkletNodeMock[] = [];

  readonly port = {
    postMessage: vi.fn(),
    onmessage: null as ((event: MessageEvent) => void) | null,
  };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();

  constructor() {
    AudioWorkletNodeMock.instances.push(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  AudioWorkletNodeMock.instances = [];
});

describe("PcmSourcePlayback", () => {
  it("uses one frame index for the master and every selected stem", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioWorkletNode", AudioWorkletNodeMock);
    const { context, graph, delay } = createGraph();
    const readPlaybackAudioFrames = vi.fn(
      ({ sourcePaths, frameCount }: { sourcePaths: string[]; frameCount: number }) =>
        Promise.resolve(
          new ArrayBuffer(sourcePaths.length * frameCount * 2 * Float32Array.BYTES_PER_ELEMENT),
        ),
    );
    const client = { readPlaybackAudioFrames } as unknown as LocalApiClient;
    const playback = await PcmSourcePlayback.create(
      client,
      {
        path: "analysis.wav",
        sampleRate: 44_100,
        channels: 2,
        frameCount: 44_100 * 10,
      },
      [
        { type: "drums", path: "drums.wav" },
        { type: "bass", path: "bass.wav" },
      ],
      graph,
    );
    const worklet = AudioWorkletNodeMock.instances[0];

    playback.setMode("comparison");
    playback.setVolume(0.45);
    playback.setSourceDelayMs(15);
    playback.setStemStates([stem("drums", false, true), stem("bass")]);
    playback.seek(7);
    await playback.prepare();

    expect(readPlaybackAudioFrames).toHaveBeenNthCalledWith(1, {
      sourcePaths: ["analysis.wav", "drums.wav", "bass.wav"],
      startFrame: 44_100 * 7,
      frameCount: 44_100 * 2,
    });
    expect(readPlaybackAudioFrames).toHaveBeenNthCalledWith(2, {
      sourcePaths: ["analysis.wav", "drums.wav", "bass.wav"],
      startFrame: 44_100 * 9,
      frameCount: 44_100,
    });
    expect(delay.delayTime.value).toBe(0.015);
    expect(worklet.port.postMessage).toHaveBeenCalledWith({
      type: "gains",
      gains: [0, 1, 0],
      immediate: true,
    });

    const anchor = await playback.primeStart(7.2);
    expect(anchor).toEqual({
      contextTimeSec: 3.05,
      sourceTimeSec: 7.2,
      audibleContextTimeSec: 3.05,
    });
    expect(worklet.port.postMessage).toHaveBeenCalledWith({
      type: "start",
      contextFrame: 134_505,
      sourceFrame: 317_520,
      endSourceFrame: 441_000,
    });

    playback.setStemStates([stem("drums"), stem("bass")]);
    expect(worklet.port.postMessage).toHaveBeenCalledWith({
      type: "gains",
      gains: [1, 0, 0],
      immediate: false,
    });
    context.currentTime = 3.25;
    expect(playback.currentSourceTime()).toBeCloseTo(7.4, 5);

    await playback.destroy();
    expect(graph.destroy).not.toHaveBeenCalled();
  });

  it("requires the output AudioContext to run at 44.1 kHz", async () => {
    vi.stubGlobal("AudioWorkletNode", AudioWorkletNodeMock);
    const { graph } = createGraph(48_000);

    await expect(
      PcmSourcePlayback.create(
        {} as LocalApiClient,
        {
          path: "analysis.wav",
          sampleRate: 44_100,
          channels: 2,
          frameCount: 44_100,
        },
        [],
        graph,
      ),
    ).rejects.toThrow("再生サンプルレートが44.1 kHzではありません: 48000 Hz");
  });
});

describe("PCM source playback worklet", () => {
  it("mixes the selected source at the scheduled context frame", async () => {
    let processorConstructor: (new () => {
      port: {
        onmessage: ((event: MessageEvent) => void) | null;
        postMessage: ReturnType<typeof vi.fn>;
      };
      process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
    }) | null = null;
    class AudioWorkletProcessorMock {
      readonly port = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: vi.fn(),
      };
    }
    vi.stubGlobal("AudioWorkletProcessor", AudioWorkletProcessorMock);
    vi.stubGlobal(
      "registerProcessor",
      vi.fn((_name: string, constructor: typeof processorConstructor) => {
        processorConstructor = constructor;
      }),
    );
    vi.stubGlobal("currentFrame", 100);
    await import("./pcm-source-playback-worklet.js");
    expect(processorConstructor).not.toBeNull();
    const processor = new processorConstructor!();
    const send = (data: object) =>
      processor.port.onmessage?.({ data } as MessageEvent);
    send({ type: "configure", sourceCount: 2 });
    send({
      type: "chunk",
      startFrame: 1_000,
      frameCount: 2,
      samples: new Float32Array([
        1, 10, 2, 20,
        3, 30, 4, 40,
      ]).buffer,
    });
    send({ type: "gains", gains: [0, 1], immediate: true });
    send({
      type: "start",
      contextFrame: 100,
      sourceFrame: 1_000,
      endSourceFrame: 1_002,
    });
    const left = new Float32Array(4);
    const right = new Float32Array(4);

    expect(processor.process([], [[left, right]])).toBe(true);
    expect([...left]).toEqual([3, 4, 0, 0]);
    expect([...right]).toEqual([30, 40, 0, 0]);
    expect(processor.port.postMessage).toHaveBeenCalledOnce();
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: "ended" });
  });
});
