import pcmSourcePlaybackWorkletUrl from "./pcm-source-playback-worklet.js?url";
import type { LocalApiClient } from "./api";
import type { PlaybackAudioOutputGraph } from "./playback-audio-output";
import type { PlaybackStartAnchor } from "./playback-transport";
import type { PlaybackSource } from "./soundfont-playback";
import type { PlaybackAudioInfo, ProjectStem, StemType } from "./types";

const PLAYBACK_SAMPLE_RATE = 44_100;
const CHUNK_FRAME_COUNT = PLAYBACK_SAMPLE_RATE * 2;
const INITIAL_CHUNK_COUNT = 2;
const REFILL_INTERVAL_MS = 500;
const REFILL_THRESHOLD_FRAMES = PLAYBACK_SAMPLE_RATE * 3;
const START_LEAD_SEC = 0.05;
const GAIN_RAMP_SEC = 0.01;
const MAX_SOURCE_DELAY_SEC = 0.2;

interface StemPlaybackInput {
  type: StemType;
  path: string;
}

export class PcmSourcePlayback {
  readonly #client: LocalApiClient;
  readonly #audioOutput: PlaybackAudioOutputGraph;
  readonly #context: AudioContext;
  readonly #node: AudioWorkletNode;
  readonly #sourcePaths: readonly string[];
  readonly #sourceIndexByStem = new Map<StemType, number>();
  readonly #frameCount: number;
  readonly #sourceDelay: DelayNode;
  readonly #centerGain: GainNode;
  readonly #monoBus: GainNode;
  readonly #leftPanner: StereoPannerNode;
  readonly #comparisonGain: GainNode;
  #mode: PlaybackSource = "original";
  #volume = 1;
  #stemStates = new Map<StemType, Pick<ProjectStem, "mute" | "solo">>();
  #sourceFrame = 0;
  #startContextTimeSec = 0;
  #startSourceFrame = 0;
  #bufferedFromFrame = 0;
  #bufferedThroughFrame = 0;
  #nextFetchFrame = 0;
  #playing = false;
  #destroyed = false;
  #refillTimer: number | null = null;
  #loadGeneration = 0;
  #loadInProgress = false;
  #endedHandler: (() => void) | null = null;
  #errorHandler: ((message: string) => void) | null = null;

  private constructor(
    client: LocalApiClient,
    audioOutput: PlaybackAudioOutputGraph,
    node: AudioWorkletNode,
    master: PlaybackAudioInfo,
    stems: readonly StemPlaybackInput[],
    sourceDelay: DelayNode,
    centerGain: GainNode,
    monoBus: GainNode,
    leftPanner: StereoPannerNode,
    comparisonGain: GainNode,
  ) {
    this.#client = client;
    this.#audioOutput = audioOutput;
    this.#context = audioOutput.context;
    this.#node = node;
    this.#sourcePaths = [master.path, ...stems.map((stem) => stem.path)];
    stems.forEach((stem, index) => {
      this.#sourceIndexByStem.set(stem.type, index + 1);
    });
    this.#frameCount = master.frameCount;
    this.#sourceDelay = sourceDelay;
    this.#centerGain = centerGain;
    this.#monoBus = monoBus;
    this.#leftPanner = leftPanner;
    this.#comparisonGain = comparisonGain;
    this.#node.port.onmessage = ({ data }) => {
      if (data?.type === "ended") {
        this.pause();
        this.#endedHandler?.();
      } else if (data?.type === "underrun") {
        this.pause();
        this.#errorHandler?.("再生用PCMの供給が間に合いませんでした");
      }
    };
  }

  static async create(
    client: LocalApiClient,
    master: PlaybackAudioInfo,
    stems: readonly StemPlaybackInput[],
    audioOutput: PlaybackAudioOutputGraph,
  ): Promise<PcmSourcePlayback> {
    const context = audioOutput.context;
    if (context.sampleRate !== PLAYBACK_SAMPLE_RATE) {
      throw new Error(
        `再生サンプルレートが44.1 kHzではありません: ${context.sampleRate} Hz`,
      );
    }
    await context.audioWorklet.addModule(pcmSourcePlaybackWorkletUrl);
    const node = new AudioWorkletNode(context, "earcopy-pcm-source-playback", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const sourceDelay = context.createDelay(MAX_SOURCE_DELAY_SEC);
    const centerGain = context.createGain();
    const monoBus = context.createGain();
    monoBus.channelCount = 1;
    monoBus.channelCountMode = "explicit";
    monoBus.channelInterpretation = "speakers";
    const leftPanner = context.createStereoPanner();
    leftPanner.pan.value = -1;
    const comparisonGain = context.createGain();
    centerGain.gain.value = 0;
    comparisonGain.gain.value = 0;
    node.connect(sourceDelay);
    sourceDelay.connect(centerGain);
    sourceDelay.connect(monoBus);
    centerGain.connect(audioOutput.destination);
    monoBus.connect(leftPanner);
    leftPanner.connect(comparisonGain);
    comparisonGain.connect(audioOutput.destination);
    node.port.postMessage({
      type: "configure",
      sourceCount: stems.length + 1,
    });
    const playback = new PcmSourcePlayback(
      client,
      audioOutput,
      node,
      master,
      stems,
      sourceDelay,
      centerGain,
      monoBus,
      leftPanner,
      comparisonGain,
    );
    playback.#sendInputGains(true);
    return playback;
  }

  setEndedHandler(handler: (() => void) | null): void {
    this.#endedHandler = handler;
  }

  setErrorHandler(handler: ((message: string) => void) | null): void {
    this.#errorHandler = handler;
  }

  setMode(mode: PlaybackSource): void {
    this.#mode = mode;
    this.#updateRouting(this.#playing);
    this.#sendInputGains(!this.#playing);
  }

  setVolume(volume: number): void {
    this.#volume = Number.isFinite(volume)
      ? Math.min(1, Math.max(0, volume))
      : 1;
    this.#updateRouting(this.#playing);
  }

  setSourceDelayMs(delayMs: number): void {
    this.#sourceDelay.delayTime.value = Number.isFinite(delayMs)
      ? Math.min(MAX_SOURCE_DELAY_SEC, Math.max(0, delayMs / 1000))
      : 0;
  }

  setStemStates(stems: readonly ProjectStem[]): void {
    this.#stemStates = new Map(
      stems.map((stem) => [
        stem.type,
        { mute: stem.mute, solo: stem.solo },
      ]),
    );
    this.#sendInputGains(!this.#playing);
  }

  seek(sourceTimeSec: number): void {
    this.pause();
    this.#sourceFrame = this.#clampSourceFrame(
      Math.round(sourceTimeSec * PLAYBACK_SAMPLE_RATE),
    );
  }

  get isPlaying(): boolean {
    return this.#playing;
  }

  currentSourceTime(): number {
    if (!this.#playing) {
      return this.#sourceFrame / PLAYBACK_SAMPLE_RATE;
    }
    const elapsedFrames = Math.max(
      0,
      Math.floor(
        (this.#context.currentTime - this.#startContextTimeSec) *
          PLAYBACK_SAMPLE_RATE,
      ),
    );
    return Math.min(
      this.#frameCount,
      this.#startSourceFrame + elapsedFrames,
    ) / PLAYBACK_SAMPLE_RATE;
  }

  async prepare(): Promise<void> {
    if (this.#playing) {
      this.pause();
    }
    await this.#audioOutput.start();
    const generation = ++this.#loadGeneration;
    this.#loadInProgress = false;
    this.#node.port.postMessage({ type: "pause" });
    this.#nextFetchFrame = this.#sourceFrame;
    this.#bufferedFromFrame = this.#sourceFrame;
    this.#bufferedThroughFrame = this.#sourceFrame;
    const starts = Array.from({ length: INITIAL_CHUNK_COUNT }, (_, index) =>
      this.#sourceFrame + index * CHUNK_FRAME_COUNT,
    );
    const chunks = await Promise.all(
      starts.map((startFrame) => this.#readChunk(startFrame, generation)),
    );
    if (generation !== this.#loadGeneration) {
      return;
    }
    for (const chunk of chunks) {
      this.#postChunk(chunk.startFrame, chunk.frameCount, chunk.samples);
    }
    this.#nextFetchFrame =
      this.#sourceFrame + INITIAL_CHUNK_COUNT * CHUNK_FRAME_COUNT;
    this.#bufferedThroughFrame = Math.min(
      this.#frameCount,
      this.#nextFetchFrame,
    );
  }

  async primeStart(sourceTimeSec?: number): Promise<PlaybackStartAnchor> {
    if (sourceTimeSec !== undefined) {
      const requestedFrame = this.#clampSourceFrame(
        Math.round(sourceTimeSec * PLAYBACK_SAMPLE_RATE),
      );
      const requestedFrameIsPrepared =
        requestedFrame >= this.#bufferedFromFrame &&
        (requestedFrame < this.#bufferedThroughFrame ||
          requestedFrame === this.#frameCount);
      if (!requestedFrameIsPrepared) {
        throw new Error(
          "再生経路の切り替え中に再生位置がPCM準備済み区間を超えました",
        );
      }
      this.#sourceFrame = requestedFrame;
    }
    const contextFrame = Math.ceil(
      (this.#context.currentTime + START_LEAD_SEC) * PLAYBACK_SAMPLE_RATE,
    );
    const contextTimeSec = contextFrame / PLAYBACK_SAMPLE_RATE;
    this.#startContextTimeSec = contextTimeSec;
    this.#startSourceFrame = this.#sourceFrame;
    this.#playing = true;
    this.#sendInputGains(true);
    this.#node.port.postMessage({
      type: "start",
      contextFrame,
      sourceFrame: this.#startSourceFrame,
      endSourceFrame: this.#frameCount,
    });
    this.#startRefillTimer();
    return {
      contextTimeSec,
      sourceTimeSec: this.#startSourceFrame / PLAYBACK_SAMPLE_RATE,
      audibleContextTimeSec: contextTimeSec,
    };
  }

  activateAt(anchor: PlaybackStartAnchor): void {
    this.#updateRoutingAt(anchor.audibleContextTimeSec);
  }

  async start(): Promise<void> {
    await this.prepare();
    const anchor = await this.primeStart();
    this.activateAt(anchor);
  }

  pause(): void {
    if (this.#playing) {
      this.#sourceFrame = this.#clampSourceFrame(
        Math.round(this.currentSourceTime() * PLAYBACK_SAMPLE_RATE),
      );
    }
    this.#playing = false;
    this.#loadGeneration += 1;
    this.#loadInProgress = false;
    this.#node.port.postMessage({ type: "pause" });
    if (this.#refillTimer !== null) {
      window.clearInterval(this.#refillTimer);
      this.#refillTimer = null;
    }
    this.#rampGain(this.#centerGain, 0);
    this.#rampGain(this.#comparisonGain, 0);
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.pause();
    this.#node.disconnect();
    this.#sourceDelay.disconnect();
    this.#centerGain.disconnect();
    this.#monoBus.disconnect();
    this.#leftPanner.disconnect();
    this.#comparisonGain.disconnect();
  }

  #clampSourceFrame(frame: number): number {
    return Math.min(this.#frameCount, Math.max(0, frame));
  }

  #selectedSourceIndices(): readonly number[] {
    if (this.#mode === "transcription") {
      return [];
    }
    const states = [...this.#stemStates.entries()].filter(([type]) =>
      this.#sourceIndexByStem.has(type),
    );
    const solo = states.filter(([, state]) => state.solo);
    if (solo.length > 0) {
      return solo.flatMap(([type, state]) => {
        const index = this.#sourceIndexByStem.get(type);
        return state.mute || index === undefined ? [] : [index];
      });
    }
    if (states.some(([, state]) => state.mute)) {
      return states.flatMap(([type, state]) => {
        const index = this.#sourceIndexByStem.get(type);
        return state.mute || index === undefined ? [] : [index];
      });
    }
    return [0];
  }

  #sendInputGains(immediate: boolean): void {
    const selected = new Set(this.#selectedSourceIndices());
    this.#node.port.postMessage({
      type: "gains",
      gains: this.#sourcePaths.map((_, index) => (selected.has(index) ? 1 : 0)),
      immediate,
    });
  }

  async #readChunk(
    startFrame: number,
    generation: number,
  ): Promise<{ startFrame: number; frameCount: number; samples: ArrayBuffer }> {
    const frameCount = Math.max(
      0,
      Math.min(CHUNK_FRAME_COUNT, this.#frameCount - startFrame),
    );
    if (frameCount === 0 || generation !== this.#loadGeneration) {
      return { startFrame, frameCount: 0, samples: new ArrayBuffer(0) };
    }
    const samples = await this.#client.readPlaybackAudioFrames({
      sourcePaths: this.#sourcePaths,
      startFrame,
      frameCount,
    });
    const expectedByteLength =
      this.#sourcePaths.length *
      frameCount *
      2 *
      Float32Array.BYTES_PER_ELEMENT;
    if (samples.byteLength !== expectedByteLength) {
      throw new Error(
        `再生用PCMのデータ長が一致しません: ${samples.byteLength} / ${expectedByteLength} bytes`,
      );
    }
    return { startFrame, frameCount, samples };
  }

  #postChunk(startFrame: number, frameCount: number, samples: ArrayBuffer): void {
    if (frameCount === 0) {
      return;
    }
    this.#node.port.postMessage(
      { type: "chunk", startFrame, frameCount, samples },
      [samples],
    );
  }

  #startRefillTimer(): void {
    if (this.#refillTimer !== null) {
      window.clearInterval(this.#refillTimer);
    }
    this.#refillTimer = window.setInterval(() => {
      void this.#refill();
    }, REFILL_INTERVAL_MS);
  }

  async #refill(): Promise<void> {
    if (!this.#playing || this.#loadInProgress) {
      return;
    }
    const currentFrame = Math.round(this.currentSourceTime() * PLAYBACK_SAMPLE_RATE);
    if (
      this.#bufferedThroughFrame - currentFrame >= REFILL_THRESHOLD_FRAMES ||
      this.#nextFetchFrame >= this.#frameCount
    ) {
      return;
    }
    const generation = this.#loadGeneration;
    const startFrame = this.#nextFetchFrame;
    this.#loadInProgress = true;
    try {
      const chunk = await this.#readChunk(startFrame, generation);
      if (generation !== this.#loadGeneration || !this.#playing) {
        return;
      }
      this.#postChunk(chunk.startFrame, chunk.frameCount, chunk.samples);
      this.#nextFetchFrame += chunk.frameCount;
      this.#bufferedThroughFrame = this.#nextFetchFrame;
    } catch (reason) {
      if (generation !== this.#loadGeneration) {
        return;
      }
      this.pause();
      this.#errorHandler?.(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      if (generation === this.#loadGeneration) {
        this.#loadInProgress = false;
      }
    }
  }

  #updateRouting(ramp: boolean): void {
    const sourceActive = this.#playing && this.#mode !== "transcription";
    const centerTarget =
      sourceActive && this.#mode === "original" ? this.#volume : 0;
    const comparisonTarget =
      sourceActive && this.#mode === "comparison" ? this.#volume : 0;
    if (ramp) {
      this.#rampGain(this.#centerGain, centerTarget);
      this.#rampGain(this.#comparisonGain, comparisonTarget);
    } else {
      this.#centerGain.gain.value = centerTarget;
      this.#comparisonGain.gain.value = comparisonTarget;
    }
  }

  #updateRoutingAt(contextTimeSec: number): void {
    const sourceActive = this.#playing && this.#mode !== "transcription";
    const centerTarget =
      sourceActive && this.#mode === "original" ? this.#volume : 0;
    const comparisonTarget =
      sourceActive && this.#mode === "comparison" ? this.#volume : 0;
    this.#rampGainAt(this.#centerGain, centerTarget, contextTimeSec);
    this.#rampGainAt(this.#comparisonGain, comparisonTarget, contextTimeSec);
  }

  #rampGain(node: GainNode, target: number): void {
    const now = this.#context.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(node.gain.value, now);
    node.gain.linearRampToValueAtTime(target, now + GAIN_RAMP_SEC);
  }

  #rampGainAt(node: GainNode, target: number, contextTimeSec: number): void {
    const startTime = Math.max(this.#context.currentTime, contextTimeSec);
    node.gain.cancelScheduledValues(this.#context.currentTime);
    node.gain.setValueAtTime(0, startTime);
    node.gain.linearRampToValueAtTime(target, startTime + GAIN_RAMP_SEC);
  }
}
