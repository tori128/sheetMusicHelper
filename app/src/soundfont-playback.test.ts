import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaybackAudioOutputGraph } from "./playback-audio-output";
import {
  audibleTrackIds,
  NOTE_PREVIEW_MINIMUM_DURATION_MS,
  normalizeAudioOutputDevices,
  resolveTimelineSeek,
  soundFontVoiceRequirements,
  sourceTimeToTimelineTime,
  SoundFontPlaybackEngine,
} from "./soundfont-playback";
import type { ProjectNote, ProjectTrack } from "./types";

const synthSpies = vi.hoisted(() => ({
  programChange: vi.fn(),
  controllerChange: vi.fn(),
  stopAll: vi.fn(),
  noteOn: vi.fn(),
  noteOff: vi.fn(),
  addNewChannel: vi.fn(),
  setDrums: vi.fn(),
  setSystemParameter: vi.fn(),
  getSnapshot: vi.fn().mockResolvedValue({}),
  loadNewSongList: vi.fn(),
  getMIDI: vi.fn().mockResolvedValue({}),
}));

vi.mock("spessasynth_lib", () => ({
  Sequencer: class {
    readonly loadNewSongList = synthSpies.loadNewSongList;
    readonly getMIDI = synthSpies.getMIDI;
  },
  WorkletSynthesizer: class {
    readonly isReady = Promise.resolve();
    readonly soundBankManager = {
      addSoundBank: vi.fn().mockResolvedValue(undefined),
    };
    readonly connect = vi.fn();
    readonly midiChannels = Array.from({ length: 16 }, () => ({
      setDrums: synthSpies.setDrums,
    }));
    readonly programChange = synthSpies.programChange;
    readonly controllerChange = synthSpies.controllerChange;
    readonly stopAll = synthSpies.stopAll;
    readonly noteOn = synthSpies.noteOn;
    readonly noteOff = synthSpies.noteOff;
    readonly setSystemParameter = synthSpies.setSystemParameter;
    readonly getSnapshot = synthSpies.getSnapshot;
    readonly destroy = vi.fn();
    readonly addNewChannel = () => {
      synthSpies.addNewChannel();
      this.midiChannels.push({ setDrums: synthSpies.setDrums });
    };
  },
}));

afterEach(() => {
  synthSpies.programChange.mockClear();
  synthSpies.controllerChange.mockClear();
  synthSpies.stopAll.mockClear();
  synthSpies.noteOn.mockClear();
  synthSpies.noteOff.mockClear();
  synthSpies.addNewChannel.mockClear();
  synthSpies.setDrums.mockClear();
  synthSpies.setSystemParameter.mockClear();
  synthSpies.getSnapshot.mockClear();
  synthSpies.loadNewSongList.mockClear();
  synthSpies.getMIDI.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  synthSpies.getSnapshot.mockResolvedValue({});
});

function track(id: string, mute = false, solo = false): ProjectTrack {
  return {
    id,
    displayName: id,
    instrumentId: "acoustic_piano",
    kind: "pitched",
    color: "#112233",
    order: 1,
    midiChannel: 1,
    gmProgram: 0,
    playbackOctaveShift: 0,
    playbackVolume: 100,
    mute,
    solo,
  };
}

function note(
  id: string,
  trackId: string,
  startSec: number,
  endSec: number,
  pitch = 60,
): ProjectNote {
  return {
    id,
    sourceInstrumentId: "acoustic_piano",
    trackId,
    pitch,
    rawStartSec: startSec,
    rawEndSec: endSec,
    startSec,
    endSec,
    velocity: 100,
  };
}

describe("audibleTrackIds", () => {
  it("excludes muted tracks when no solo is active", () => {
    expect([...audibleTrackIds([track("a"), track("b", true)])]).toEqual([
      "a",
    ]);
  });

  it("uses only solo tracks when solo is active", () => {
    expect([...audibleTrackIds([track("a"), track("b", false, true)])]).toEqual([
      "b",
    ]);
  });

  it("excludes a muted Solo track from playback", () => {
    expect([...audibleTrackIds([track("a"), track("b", true, true)])]).toEqual(
      [],
    );
  });
});

describe("SoundFont voice requirements", () => {
  it("distinguishes program, pitch, and velocity and removes duplicates", () => {
    const piano = { ...track("piano"), gmProgram: 4 };
    const vocal: ProjectTrack = {
      ...track("vocal"),
      gmProgram: 71,
      playbackOctaveShift: 1,
    };
    const drums: ProjectTrack = {
      ...track("drums"),
      kind: "drums",
      instrumentId: "drums",
      midiChannel: 10,
      gmProgram: null,
    };
    const pianoQuiet = { ...note("piano-quiet", piano.id, 0, 1), velocity: 64 };
    const requirements = soundFontVoiceRequirements(
      [piano, vocal, drums],
      [
        pianoQuiet,
        { ...pianoQuiet, id: "piano-quiet-duplicate" },
        note("piano-loud", piano.id, 1, 2),
        note("vocal", vocal.id, 0, 1),
        note("drums", drums.id, 0, 0.1, 36),
      ],
    );

    expect([...requirements.keys()]).toEqual([
      "program:4:60:64",
      "program:4:60:100",
      "program:71:72:100",
      "drums:36:100",
    ]);
  });
});

describe("track playback volume", () => {
  it("sets MIDI channel volume from the track percentage", async () => {
    const { engine } = await createTestEngine();
    const piano = { ...track("piano"), playbackVolume: 50 };

    engine.setProject([piano], []);

    expect(synthSpies.controllerChange).toHaveBeenCalledWith(0, 7, 50);
  });
});

describe("normalizeAudioOutputDevices", () => {
  it("keeps audio outputs and supplies a label when Windows hides it", () => {
    expect(
      normalizeAudioOutputDevices([
        { deviceId: "mic", kind: "audioinput", label: "Microphone" },
        { deviceId: "default", kind: "audiooutput", label: "" },
      ]),
    ).toEqual([{ deviceId: "default", label: "出力デバイス 1" }]);
  });
});

describe("source audio timeline placement", () => {
  it("converts between source time and an edited project timeline", () => {
    expect(sourceTimeToTimelineTime(3, 0.5)).toBe(3.5);
    expect(resolveTimelineSeek(3.5, 0.5, 10)).toEqual({
      sourceTimeSec: 3,
      timelineTimeSec: 3.5,
    });
    expect(resolveTimelineSeek(0, -0.5, 10)).toEqual({
      sourceTimeSec: 0.5,
      timelineTimeSec: 0,
    });
    expect(resolveTimelineSeek(0, 0.5, 10)).toEqual({
      sourceTimeSec: 0,
      timelineTimeSec: 0.5,
    });
  });
});

function createDirectOutputContext() {
  const createAudioParam = () => ({
    value: 0,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  });
  const gain = createAudioParam();
  const synthBus = {
    gain: createAudioParam(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const playbackDelay = {
    delayTime: createAudioParam(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const synthGain = {
    gain,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const comparisonMonoBus = {
    gain: createAudioParam(),
    channelCount: 2,
    channelCountMode: "max" as ChannelCountMode,
    channelInterpretation: "speakers" as ChannelInterpretation,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const comparisonGain = {
    gain: createAudioParam(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const metronomeGain = {
    gain: createAudioParam(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const clickGains: Array<{
    gain: ReturnType<typeof createAudioParam>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const oscillators: Array<{
    type: OscillatorType;
    frequency: { setValueAtTime: ReturnType<typeof vi.fn> };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  }> = [];
  const streamDestination = {
    stream: { id: "fallback-stream" },
  };
  const createGain = vi
    .fn()
    .mockReturnValueOnce(synthBus)
    .mockReturnValueOnce(synthGain)
    .mockReturnValueOnce(comparisonMonoBus)
    .mockReturnValueOnce(comparisonGain)
    .mockReturnValueOnce(metronomeGain)
    .mockImplementation(() => {
      const clickGain = {
        gain: createAudioParam(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      clickGains.push(clickGain);
      return clickGain;
    });
  const context = {
    audioWorklet: {
      addModule: vi.fn().mockResolvedValue(undefined),
    },
    currentTime: 0,
    destination: { id: "native-output" },
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createGain,
    createDelay: vi.fn(() => playbackDelay),
    createStereoPanner: vi.fn(() => ({
      pan: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createOscillator: vi.fn(() => {
      const oscillator = {
        type: "sine" as OscillatorType,
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      oscillators.push(oscillator);
      return oscillator;
    }),
    createMediaElementSource: vi.fn(),
    createMediaStreamDestination: vi.fn(() => streamDestination),
    setSinkId: vi.fn().mockResolvedValue(undefined),
  };
  return {
    context,
    gain,
    synthBus,
    playbackDelay,
    synthGain,
    comparisonMonoBus,
    comparisonGain,
    metronomeGain,
    clickGains,
    oscillators,
    streamDestination,
  };
}

async function createTestEngine() {
  const audio = document.createElement("audio");
  const setSinkId = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(audio, "setSinkId", {
    configurable: true,
    value: setSinkId,
  });
  const graph = createDirectOutputContext();
  const AudioContextMock = vi.fn(() => graph.context);
  vi.stubGlobal("AudioContext", AudioContextMock);
  const engine = await SoundFontPlaybackEngine.create(
    audio,
    new Uint8Array([1, 2, 3]),
  );
  return { audio, setSinkId, AudioContextMock, engine, ...graph };
}

describe("SoundFontPlaybackEngine audio routing", () => {
  it("preloads each required SoundFont voice once before playback", async () => {
    const { engine } = await createTestEngine();
    synthSpies.loadNewSongList.mockClear();
    synthSpies.getMIDI.mockClear();
    const piano = track("piano");
    const firstNote = note("first", piano.id, 0, 1, 60);
    engine.setProject([piano], [firstNote]);

    await engine.prepare();
    await engine.prepare();

    expect(synthSpies.loadNewSongList).toHaveBeenCalledOnce();
    expect(synthSpies.getMIDI).toHaveBeenCalledOnce();
    const firstPreloadList = synthSpies.loadNewSongList.mock.calls[0][0];
    expect(firstPreloadList).toHaveLength(1);
    expect(firstPreloadList[0].binary).toBeInstanceOf(ArrayBuffer);
    expect(() => structuredClone(firstPreloadList)).not.toThrow();

    engine.setProject(
      [piano],
      [firstNote, { ...note("second", piano.id, 1, 2, 62), velocity: 64 }],
    );
    await engine.prepare();

    expect(synthSpies.loadNewSongList).toHaveBeenCalledTimes(2);
    expect(synthSpies.getMIDI).toHaveBeenCalledTimes(2);
    await engine.destroy();
  });

  it("delays transcription playback by the requested non-negative time", async () => {
    const { engine, playbackDelay } = await createTestEngine();

    engine.setTranscriptionDelayMs(24);
    expect(playbackDelay.delayTime.value).toBe(0.024);

    engine.setTranscriptionDelayMs(-10);
    expect(playbackDelay.delayTime.value).toBe(0);
    engine.setTranscriptionDelayMs(250);
    expect(playbackDelay.delayTime.value).toBe(0.2);

    await engine.destroy();
  });

  it("uses the shared Wave output clock in comparison playback", async () => {
    const audio = document.createElement("audio");
    const graph = createDirectOutputContext();
    const sharedOutput = {
      context: graph.context as unknown as AudioContext,
      destination: graph.context.destination as unknown as AudioNode,
      start: vi.fn().mockResolvedValue(undefined),
      setOutputDevice: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    } satisfies PlaybackAudioOutputGraph;
    const AudioContextMock = vi.fn();
    vi.stubGlobal("AudioContext", AudioContextMock);

    const engine = await SoundFontPlaybackEngine.create(
      audio,
      new Uint8Array([1, 2, 3]),
      {},
      sharedOutput,
    );
    await engine.start();

    expect(AudioContextMock).not.toHaveBeenCalled();
    expect(sharedOutput.start).toHaveBeenCalledOnce();
    expect(graph.synthGain.connect).toHaveBeenCalledWith(
      sharedOutput.destination,
    );
    await engine.destroy();
    expect(sharedOutput.destroy).not.toHaveBeenCalled();
  });

  it("schedules the first note and comparison gain from one start anchor", async () => {
    const { audio, context, comparisonGain, engine } = await createTestEngine();
    Object.defineProperties(audio, {
      paused: {
        configurable: true,
        get: () => false,
      },
      currentTime: {
        configurable: true,
        get: () => 8,
      },
    });
    const piano = track("piano");
    engine.setProject([piano], [note("aligned", piano.id, 8.05, 8.2)]);
    engine.setSource("comparison");
    synthSpies.noteOn.mockClear();
    comparisonGain.gain.setValueAtTime.mockClear();
    comparisonGain.gain.linearRampToValueAtTime.mockClear();
    context.currentTime = 2;

    engine.startAt({
      contextTimeSec: 2,
      sourceTimeSec: 8,
      timelineTimeSec: 8,
      audibleContextTimeSec: 2.05,
    });

    expect(synthSpies.noteOn).toHaveBeenCalledOnce();
    expect(synthSpies.noteOn.mock.calls[0]?.slice(0, 3)).toEqual([
      0,
      60,
      100,
    ]);
    expect(synthSpies.noteOn.mock.calls[0]?.[3]?.time).toBeCloseTo(
      2.05,
      10,
    );
    expect(comparisonGain.gain.setValueAtTime).toHaveBeenCalledWith(
      0,
      2.05,
    );
    expect(
      comparisonGain.gain.linearRampToValueAtTime,
    ).toHaveBeenCalledWith(1, 2.0599999999999996);

    engine.pause();
    await engine.destroy();
  });

  it("keeps Wave playback outside the SoundFont graph", async () => {
    const {
      audio,
      setSinkId,
      AudioContextMock,
      context,
      synthGain,
      metronomeGain,
      engine,
    } = await createTestEngine();

    expect(AudioContextMock).toHaveBeenCalledWith({
      latencyHint: "playback",
      sampleRate: 44_100,
    });
    expect(context.createMediaElementSource).not.toHaveBeenCalled();
    expect(context.createMediaStreamDestination).not.toHaveBeenCalled();
    expect(synthGain.connect).toHaveBeenCalledWith(context.destination);
    expect(metronomeGain.connect).toHaveBeenCalledWith(context.destination);
    expect(audio.defaultPlaybackRate).toBe(1);
    expect(audio.playbackRate).toBe(1);
    expect(audio.preservesPitch).toBe(true);
    expect(synthSpies.setSystemParameter.mock.calls).toEqual([
      ["effectsEnabled", false],
      ["autoAllocateVoices", false],
      ["voiceCap", 128],
      ["effectsEnabled", false],
      ["voiceCap", 16],
    ]);

    await engine.setOutputDevice("headphones");
    expect(setSinkId).not.toHaveBeenCalled();
    expect(context.setSinkId).toHaveBeenCalledWith("headphones");
    await engine.destroy();
  });

  it("uses a clocked silent sink for CI smoke playback", async () => {
    const audio = document.createElement("audio");
    const graph = createDirectOutputContext();
    vi.stubGlobal("AudioContext", vi.fn(() => graph.context));

    const engine = await SoundFontPlaybackEngine.create(
      audio,
      new Uint8Array([1, 2, 3]),
      { silentOutput: true },
    );

    expect(graph.context.setSinkId).toHaveBeenCalledWith({ type: "none" });
    expect(graph.context.setSinkId.mock.invocationCallOrder[0]).toBeLessThan(
      graph.context.resume.mock.invocationCallOrder[0],
    );
    await engine.destroy();
  });

  it("keeps fallback MediaStream routing limited to SoundFont output", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const audio = document.createElement("audio");
    const graph = createDirectOutputContext();
    delete (graph.context as Partial<typeof graph.context>).setSinkId;
    vi.stubGlobal("AudioContext", vi.fn(() => graph.context));

    const engine = await SoundFontPlaybackEngine.create(
      audio,
      new Uint8Array([1, 2, 3]),
    );

    expect(graph.context.createMediaElementSource).not.toHaveBeenCalled();
    expect(graph.context.createMediaStreamDestination).toHaveBeenCalledOnce();
    expect(graph.synthGain.connect).toHaveBeenCalledWith(
      graph.streamDestination,
    );
    expect(graph.metronomeGain.connect).toHaveBeenCalledWith(
      graph.streamDestination,
    );
    await engine.destroy();
  });

  it("schedules accented and regular metronome notes through the MIDI synth", async () => {
    vi.useFakeTimers();
    const { audio, context, engine, metronomeGain } =
      await createTestEngine();
    let paused = true;
    let currentTime = 0;
    Object.defineProperties(audio, {
      paused: {
        configurable: true,
        get: () => paused,
      },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
        },
      },
    });
    context.currentTime = 4;
    engine.setMetronome({
      enabled: true,
      bpm: 120,
      beatOffsetSec: 0.1,
      timeSignature: { numerator: 4, denominator: 4 },
    });

    paused = false;
    await engine.start();

    expect(synthSpies.noteOn).toHaveBeenCalledWith(9, 76, 118, {
      time: 4.1,
    });
    expect(synthSpies.noteOff).toHaveBeenCalledWith(9, 76, {
      time: 4.1499999999999995,
    });

    currentTime = 0.55;
    context.currentTime = 4.55;
    vi.advanceTimersByTime(25);
    expect(synthSpies.noteOn).toHaveBeenCalledWith(9, 77, 92, {
      time: 4.6,
    });
    expect(synthSpies.noteOff).toHaveBeenCalledWith(9, 77, {
      time: 4.6499999999999995,
    });

    engine.setMetronome({
      enabled: false,
      bpm: 120,
      beatOffsetSec: 0.1,
      timeSignature: { numerator: 4, denominator: 4 },
    });
    expect(metronomeGain.gain.setValueAtTime).toHaveBeenLastCalledWith(
      0,
      4.55,
    );
    expect(synthSpies.stopAll).toHaveBeenCalled();

    engine.pause();
    await engine.destroy();
  });

  it("restores normal Wave speed when playback starts", async () => {
    const { audio, engine } = await createTestEngine();
    audio.defaultPlaybackRate = 0.5;
    audio.playbackRate = 0.5;
    audio.preservesPitch = false;

    await engine.start();

    expect(audio.defaultPlaybackRate).toBe(1);
    expect(audio.playbackRate).toBe(1);
    expect(audio.preservesPitch).toBe(true);
    engine.pause();
    await engine.destroy();
  });

  it("does not restart active notes when transcription results arrive", async () => {
    vi.useFakeTimers();
    const { audio, context, engine } = await createTestEngine();
    let paused = true;
    let currentTime = 1;
    Object.defineProperties(audio, {
      paused: {
        configurable: true,
        get: () => paused,
      },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
        },
      },
    });
    const piano = track("piano");
    const activeNote = note("active", piano.id, 1, 2);

    engine.setProject([piano], [activeNote]);
    engine.setSource("transcription");
    await engine.prepare();
    synthSpies.noteOn.mockClear();
    synthSpies.noteOff.mockClear();
    paused = false;
    await engine.start();

    expect(synthSpies.noteOn).toHaveBeenCalledOnce();
    const stopCount = synthSpies.stopAll.mock.calls.length;

    const futureNote = note("future", piano.id, 1.5, 1.8);
    engine.setProject([piano], [activeNote, futureNote]);
    engine.setProject([piano], [
      activeNote,
      note("late-result", piano.id, 0.95, 1.4),
      futureNote,
    ]);

    expect(synthSpies.stopAll).toHaveBeenCalledTimes(stopCount);
    expect(synthSpies.noteOn).toHaveBeenCalledOnce();

    currentTime = 1.45;
    context.currentTime = 0.45;
    vi.advanceTimersByTime(25);
    expect(synthSpies.noteOn).toHaveBeenCalledTimes(2);
    expect(synthSpies.noteOff).not.toHaveBeenCalledWith(0, 60, {
      time: 0.4,
    });

    engine.pause();
    await engine.destroy();
  });

  it("does not chase notes that began before the seek position", async () => {
    vi.useFakeTimers();
    const { audio, context, engine } = await createTestEngine();
    let paused = true;
    let currentTime = 0;
    Object.defineProperties(audio, {
      paused: {
        configurable: true,
        get: () => paused,
      },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
        },
      },
    });
    const piano = track("piano");
    engine.setProject(
      [piano],
      [
        note("elapsed", piano.id, 0, 10, 60),
        note("after-seek", piano.id, 5.1, 6, 62),
      ],
    );
    engine.setSource("transcription");
    await engine.prepare();
    paused = false;
    await engine.start();
    expect(synthSpies.noteOn).toHaveBeenCalledWith(0, 60, 100, {
      time: 0,
    });

    synthSpies.noteOn.mockClear();
    synthSpies.noteOff.mockClear();
    currentTime = 5;
    context.currentTime = 5;
    engine.seek(5);

    expect(synthSpies.noteOn).not.toHaveBeenCalledWith(
      0,
      60,
      100,
      expect.anything(),
    );
    expect(synthSpies.noteOn).toHaveBeenCalledWith(0, 62, 100, {
      time: 5.1,
    });

    currentTime = 9.7;
    context.currentTime = 9.7;
    vi.advanceTimersByTime(20);
    expect(synthSpies.noteOff).not.toHaveBeenCalledWith(0, 60, {
      time: 10,
    });

    engine.pause();
    await engine.destroy();
  });

  it("schedules notes against the edited timeline instead of raw Wave time", async () => {
    vi.useFakeTimers();
    const { audio, context, engine } = await createTestEngine();
    let paused = true;
    let currentTime = 1;
    Object.defineProperties(audio, {
      paused: {
        configurable: true,
        get: () => paused,
      },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
        },
      },
    });
    const piano = track("piano");
    engine.setTimelineOffset(0.5);
    engine.setProject([piano], [note("shifted", piano.id, 1.6, 2)]);
    engine.setSource("transcription");
    await engine.prepare();
    synthSpies.noteOn.mockClear();
    synthSpies.noteOff.mockClear();
    context.currentTime = 4;
    paused = false;

    await engine.start();

    expect(synthSpies.noteOn).toHaveBeenCalledWith(0, 60, 100, {
      time: 4.1,
    });

    engine.pause();
    await engine.destroy();
  });

  it("schedules transcription notes on the right channel in comparison mode", async () => {
    vi.useFakeTimers();
    const { audio, engine, comparisonGain, gain } = await createTestEngine();
    let paused = true;
    Object.defineProperty(audio, "paused", {
      configurable: true,
      get: () => paused,
    });
    const piano = track("piano");
    engine.setProject([piano], [note("compared", piano.id, 0, 0.2)]);
    engine.setSource("comparison");
    synthSpies.noteOn.mockClear();
    paused = false;

    await engine.start();

    expect(synthSpies.noteOn).toHaveBeenCalledOnce();
    expect(synthSpies.noteOn).toHaveBeenCalledWith(0, 60, 100, {
      time: 0,
    });
    expect(synthSpies.noteOff).toHaveBeenCalledWith(0, 60, {
      time: 0.2,
    });
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 0.01);
    expect(
      comparisonGain.gain.linearRampToValueAtTime,
    ).toHaveBeenLastCalledWith(1, 0.01);

    engine.pause();
    await engine.destroy();
  });

  it("keeps comparison scheduling on the shared output clock", async () => {
    vi.useFakeTimers();
    const { audio, context, engine } = await createTestEngine();
    let paused = true;
    let mediaTime = 0;
    Object.defineProperties(audio, {
      paused: {
        configurable: true,
        get: () => paused,
      },
      currentTime: {
        configurable: true,
        get: () => mediaTime,
        set: (value: number) => {
          mediaTime = value;
        },
      },
    });
    const piano = track("piano");
    engine.setProject(
      [piano],
      [
        note("initial", piano.id, 0, 0.1),
        note("later", piano.id, 0.4, 0.6),
      ],
    );
    engine.setSource("comparison");
    paused = false;

    await engine.start();
    synthSpies.noteOn.mockClear();

    context.currentTime = 0.1;
    mediaTime = 0.08;
    vi.advanceTimersByTime(20);

    expect(synthSpies.noteOn).toHaveBeenCalledOnce();
    const scheduledTime = synthSpies.noteOn.mock.calls[0]?.[3]?.time;
    expect(scheduledTime).toBeCloseTo(0.4, 10);

    engine.pause();
    await engine.destroy();
  });

  it("reports the shared output clock while playback is active", async () => {
    vi.useFakeTimers();
    const { audio, context, engine } = await createTestEngine();
    let mediaTime = 8;
    Object.defineProperties(audio, {
      paused: {
        configurable: true,
        get: () => false,
      },
      currentTime: {
        configurable: true,
        get: () => mediaTime,
        set: (value: number) => {
          mediaTime = value;
        },
      },
    });
    context.currentTime = 12;
    engine.startAt({
      contextTimeSec: 12,
      sourceTimeSec: 8,
      timelineTimeSec: 8.25,
      audibleContextTimeSec: 12.005,
    });

    mediaTime = 8.1;
    context.currentTime = 13.5;

    expect(engine.currentTimelineTime()).toBeCloseTo(9.75, 10);

    engine.pause();
    await engine.destroy();
  });

  it("ends an earlier same-pitch note before a nested retrigger", async () => {
    vi.useFakeTimers();
    const { audio, context, engine } = await createTestEngine();
    let paused = true;
    let currentTime = 0;
    Object.defineProperties(audio, {
      paused: {
        configurable: true,
        get: () => paused,
      },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
        },
      },
    });
    const piano = track("piano");
    engine.setProject(
      [piano],
      [
        note("sustained", piano.id, 0, 10),
        note("retriggered", piano.id, 2, 3),
      ],
    );
    engine.setSource("transcription");
    await engine.prepare();
    synthSpies.noteOn.mockClear();
    synthSpies.noteOff.mockClear();

    paused = false;
    await engine.start();

    expect(synthSpies.noteOff).not.toHaveBeenCalled();

    currentTime = 1.7;
    context.currentTime = 1.7;
    vi.advanceTimersByTime(20);

    expect(synthSpies.noteOff).toHaveBeenCalledWith(0, 60, {
      time: 2,
    });
    expect(synthSpies.noteOff).not.toHaveBeenCalledWith(0, 60, {
      time: 10,
    });

    engine.pause();
    await engine.destroy();
  });

  it("ends a sounding note when it is removed during playback", async () => {
    vi.useFakeTimers();
    const { audio, context, engine } = await createTestEngine();
    let paused = true;
    let currentTime = 0;
    Object.defineProperties(audio, {
      paused: {
        configurable: true,
        get: () => paused,
      },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
        },
      },
    });
    const piano = track("piano");
    engine.setProject([piano], [note("removed", piano.id, 0, 30)]);
    engine.setSource("transcription");
    await engine.prepare();
    synthSpies.noteOn.mockClear();
    synthSpies.noteOff.mockClear();

    paused = false;
    await engine.start();
    expect(synthSpies.noteOn).toHaveBeenCalledOnce();

    currentTime = 0.1;
    context.currentTime = 0.1;
    engine.setProject([piano], []);

    expect(synthSpies.noteOff).toHaveBeenCalledWith(0, 60, {
      time: 0.101,
    });

    engine.pause();
    await engine.destroy();
  });

  it("keeps distant note-off events out of the real-time worklet queue", async () => {
    vi.useFakeTimers();
    const { audio, context, engine } = await createTestEngine();
    let paused = true;
    let currentTime = 0;
    Object.defineProperties(audio, {
      paused: {
        configurable: true,
        get: () => paused,
      },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
        },
      },
    });
    const piano = track("piano");
    const denseChord = Array.from({ length: 64 }, (_, index) =>
      note(`dense-${index}`, piano.id, 0, 30, 24 + index),
    );
    engine.setProject([piano], denseChord);
    await engine.prepare();
    expect(synthSpies.noteOn).not.toHaveBeenCalled();
    expect(synthSpies.getSnapshot).not.toHaveBeenCalled();
    synthSpies.noteOn.mockClear();
    synthSpies.noteOff.mockClear();

    paused = false;
    await engine.start();

    expect(synthSpies.noteOn).not.toHaveBeenCalled();
    expect(synthSpies.noteOff).not.toHaveBeenCalled();

    engine.setSource("transcription");
    await engine.start();

    expect(synthSpies.noteOn).toHaveBeenCalledTimes(64);
    expect(synthSpies.noteOff).not.toHaveBeenCalled();

    currentTime = 29.7;
    context.currentTime = 29.7;
    vi.advanceTimersByTime(20);

    expect(synthSpies.noteOff).toHaveBeenCalledTimes(64);

    engine.pause();
    await engine.destroy();
  });

  it("does not generate note-ons while preparing paused playback", async () => {
    const { audio, engine, gain } = await createTestEngine();
    const tracks = Array.from({ length: 3 }, (_, index) => ({
      ...track(`track-${index}`),
      midiChannel: index + 1,
      gmProgram: index,
    }));
    const notes = tracks.flatMap((projectTrack) =>
      Array.from({ length: 128 }, (_, pitch) =>
        note(
          `${projectTrack.id}-${pitch}`,
          projectTrack.id,
          0,
          1,
          pitch,
        ),
      ),
    );

    expect(audio.paused).toBe(true);
    engine.setProject(tracks, notes);
    engine.setSource("transcription");
    await engine.prepare();

    expect(synthSpies.noteOn).not.toHaveBeenCalled();
    expect(synthSpies.getSnapshot).not.toHaveBeenCalled();
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 0.01);

    await engine.destroy();
  });

  it("silences playback and cancels scheduled note-ons on the first pause", async () => {
    vi.useFakeTimers();
    const { audio, context, engine, gain, metronomeGain } =
      await createTestEngine();
    let paused = true;
    let currentTime = 0;
    Object.defineProperties(audio, {
      paused: {
        configurable: true,
        get: () => paused,
      },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
        },
      },
    });
    const piano = track("piano");
    engine.setProject([piano], [note("future", piano.id, 0.25, 5)]);
    await engine.prepare();
    engine.setSource("transcription");
    engine.setMetronome({
      enabled: true,
      bpm: 120,
      beatOffsetSec: 0.1,
      timeSignature: { numerator: 4, denominator: 4 },
    });
    synthSpies.noteOn.mockClear();
    synthSpies.noteOff.mockClear();
    context.currentTime = 10;
    paused = false;

    await engine.start();
    engine.pause();

    expect(synthSpies.noteOn).toHaveBeenCalledWith(0, 60, 100, {
      time: 10.25,
    });
    expect(synthSpies.noteOff).toHaveBeenCalledWith(0, 60, {
      time: 10.251,
    });
    expect(synthSpies.noteOff).toHaveBeenCalledWith(9, 76, {
      time: 10.100999999999999,
    });
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(0, 10);
    expect(metronomeGain.gain.setValueAtTime).toHaveBeenLastCalledWith(
      0,
      10,
    );

    await engine.destroy();
  });

  it("holds a selected note until preview release", async () => {
    vi.useFakeTimers();
    const { engine, gain, context } = await createTestEngine();
    const piano = track("piano");
    const selectedNote = note("selected", piano.id, 1, 2);
    engine.setProject([piano], [selectedNote]);

    await engine.startNotePreview(piano, selectedNote);

    expect(synthSpies.programChange).toHaveBeenLastCalledWith(16, 0);
    expect(synthSpies.setDrums).toHaveBeenLastCalledWith(false);
    expect(synthSpies.noteOn).toHaveBeenCalledWith(16, 60, 100, {
      time: 0,
    });
    expect(synthSpies.noteOff).not.toHaveBeenCalled();
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 0.01);

    vi.advanceTimersByTime(2_000);
    expect(synthSpies.noteOff).not.toHaveBeenCalled();

    context.currentTime = 2;
    engine.releaseNotePreview();

    expect(synthSpies.noteOff).toHaveBeenCalledWith(16, 60, {
      time: 2,
    });
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 2.01);

    await engine.destroy();
  });

  it("raises vocal playback by one octave without changing the note", async () => {
    vi.useFakeTimers();
    const { engine, context } = await createTestEngine();
    const vocal: ProjectTrack = {
      ...track("vocal"),
      instrumentId: "voice",
      gmProgram: 71,
      playbackOctaveShift: 1,
    };
    const selectedNote = note("selected", vocal.id, 1, 2, 60);
    engine.setProject([vocal], [selectedNote]);

    await engine.startNotePreview(vocal, selectedNote);

    expect(synthSpies.noteOn).toHaveBeenCalledWith(16, 72, 100, {
      time: 0,
    });
    context.currentTime = 0.5;
    engine.stopNotePreview();
    expect(synthSpies.noteOff).toHaveBeenCalledWith(16, 72, {
      time: 0.5,
    });
    expect(selectedNote.pitch).toBe(60);

    await engine.destroy();
  });

  it("keeps a quick note click audible for the minimum preview duration", async () => {
    vi.useFakeTimers();
    const { engine, context } = await createTestEngine();
    const piano = track("piano");
    const selectedNote = note("selected", piano.id, 1, 2);
    engine.setProject([piano], [selectedNote]);

    await engine.startNotePreview(piano, selectedNote);
    engine.releaseNotePreview();

    vi.advanceTimersByTime(NOTE_PREVIEW_MINIMUM_DURATION_MS - 1);
    expect(synthSpies.noteOff).not.toHaveBeenCalled();

    context.currentTime = NOTE_PREVIEW_MINIMUM_DURATION_MS / 1000;
    vi.advanceTimersByTime(1);
    expect(synthSpies.noteOff).toHaveBeenCalledWith(16, 60, {
      time: NOTE_PREVIEW_MINIMUM_DURATION_MS / 1000,
    });

    await engine.destroy();
  });

  it("stops immediately when a pending preview is cancelled", async () => {
    vi.useFakeTimers();
    const { engine, context } = await createTestEngine();
    const piano = track("piano");
    const selectedNote = note("selected", piano.id, 1, 2);
    engine.setProject([piano], [selectedNote]);

    await engine.startNotePreview(piano, selectedNote);
    engine.releaseNotePreview();
    context.currentTime = 0.1;
    engine.stopNotePreview();

    expect(synthSpies.noteOff).toHaveBeenCalledOnce();
    expect(synthSpies.noteOff).toHaveBeenCalledWith(16, 60, { time: 0.1 });
    vi.advanceTimersByTime(NOTE_PREVIEW_MINIMUM_DURATION_MS);
    expect(synthSpies.noteOff).toHaveBeenCalledOnce();

    await engine.destroy();
  });
});
