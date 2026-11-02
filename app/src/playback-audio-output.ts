type SinkRoutableAudioContext = AudioContext & {
  setSinkId?: (sinkId: string | { type: "none" }) => Promise<void>;
};

export function supportsDirectAudioOutput(): boolean {
  return typeof (AudioContext.prototype as SinkRoutableAudioContext)
    .setSinkId === "function";
}

export interface PlaybackAudioOutputGraph {
  readonly context: AudioContext;
  readonly destination: AudioNode;
  start(): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;
  destroy(): Promise<void>;
}

interface PlaybackAudioOutputOptions {
  silentOutput?: boolean;
}

export class PlaybackAudioOutput implements PlaybackAudioOutputGraph {
  readonly context: AudioContext;
  readonly destination: AudioNode;
  readonly #output: HTMLAudioElement | null;
  #destroyed = false;

  private constructor(
    context: AudioContext,
    destination: AudioNode,
    output: HTMLAudioElement | null,
  ) {
    this.context = context;
    this.destination = destination;
    this.#output = output;
  }

  static async create(
    referenceAudio: HTMLAudioElement,
    options: PlaybackAudioOutputOptions = {},
  ): Promise<PlaybackAudioOutput> {
    const context = new AudioContext({
      latencyHint: "playback",
      sampleRate: 44_100,
    });
    const routableContext = context as SinkRoutableAudioContext;
    if (
      options.silentOutput &&
      typeof routableContext.setSinkId === "function"
    ) {
      await routableContext.setSinkId({ type: "none" });
    }

    let destination: AudioNode = context.destination;
    let output: HTMLAudioElement | null = null;
    if (typeof routableContext.setSinkId !== "function") {
      const streamDestination = context.createMediaStreamDestination();
      destination = streamDestination;
      output = new Audio();
      output.srcObject = streamDestination.stream;
      output.muted = referenceAudio.muted;
    }
    await context.resume();
    return new PlaybackAudioOutput(context, destination, output);
  }

  async start(): Promise<void> {
    await this.context.resume();
    await this.#output?.play();
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    const routableContext = this.context as SinkRoutableAudioContext;
    if (typeof routableContext.setSinkId === "function") {
      await routableContext.setSinkId(deviceId);
      return;
    }
    if (
      this.#output !== null &&
      typeof this.#output.setSinkId === "function"
    ) {
      await this.#output.setSinkId(deviceId);
      return;
    }
    if (deviceId && deviceId !== "default") {
      throw new Error("この環境では出力デバイスを選択できません");
    }
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    if (this.#output !== null) {
      this.#output.pause();
      this.#output.srcObject = null;
    }
    await this.context.close();
  }
}
