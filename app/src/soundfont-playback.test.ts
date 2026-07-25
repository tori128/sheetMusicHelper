import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audibleTrackIds,
  normalizeAudioOutputDevices,
  SoundFontPlaybackEngine,
} from "./soundfont-playback";
import type { ProjectNote, ProjectTrack } from "./types";

const synthSpies = vi.hoisted(() => ({
  programChange: vi.fn(),
  stopAll: vi.fn(),
  noteOn: vi.fn(),
  noteOff: vi.fn(),
}));

vi.mock("spessasynth_lib", () => ({
  WorkletSynthesizer: class {
    readonly isReady = Promise.resolve();
    readonly soundBankManager = {
      addSoundBank: vi.fn().mockResolvedValue(undefined),
    };
    readonly connect = vi.fn();
    readonly programChange = synthSpies.programChange;
    readonly stopAll = synthSpies.stopAll;
    readonly noteOn = synthSpies.noteOn;
    readonly noteOff = synthSpies.noteOff;
    readonly destroy = vi.fn();
  },
}));

afterEach(() => {
  synthSpies.programChange.mockClear();
  synthSpies.stopAll.mockClear();
  synthSpies.noteOn.mockClear();
  synthSpies.noteOff.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    mute,
    solo,
  };
}

function note(
  id: string,
  trackId: string,
  startSec: number,
  endSec: number,
): ProjectNote {
  return {
    id,
    sourceInstrumentId: "acoustic_piano",
    trackId,
    pitch: 60,
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

function createDirectOutputContext() {
  const gain = {
    value: 0,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
  const synthGain = {
    gain,
    connect: vi.fn(),
  };
  const streamDestination = {
    stream: { id: "fallback-stream" },
  };
  const context = {
    audioWorklet: {
      addModule: vi.fn().mockResolvedValue(undefined),
    },
    currentTime: 0,
    destination: { id: "native-output" },
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createGain: vi.fn(() => synthGain),
    createMediaElementSource: vi.fn(),
    createMediaStreamDestination: vi.fn(() => streamDestination),
    setSinkId: vi.fn().mockResolvedValue(undefined),
  };
  return { context, gain, synthGain, streamDestination };
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
  it("keeps Wave playback outside the SoundFont graph", async () => {
    const {
      audio,
      setSinkId,
      AudioContextMock,
      context,
      synthGain,
      engine,
    } = await createTestEngine();

    expect(AudioContextMock).toHaveBeenCalledWith({
      latencyHint: "playback",
    });
    expect(context.createMediaElementSource).not.toHaveBeenCalled();
    expect(context.createMediaStreamDestination).not.toHaveBeenCalled();
    expect(synthGain.connect).toHaveBeenCalledWith(context.destination);
    expect(audio.defaultPlaybackRate).toBe(1);
    expect(audio.playbackRate).toBe(1);
    expect(audio.preservesPitch).toBe(true);

    await engine.setOutputDevice("headphones");
    expect(setSinkId).toHaveBeenCalledWith("headphones");
    expect(context.setSinkId).toHaveBeenCalledWith("headphones");
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
    await engine.destroy();
  });

  it("restores normal Wave speed after pause and ramps source changes", async () => {
    vi.useFakeTimers();
    const { audio, engine } = await createTestEngine();
    audio.defaultPlaybackRate = 0.5;
    audio.playbackRate = 0.5;
    audio.preservesPitch = false;

    await engine.start();

    expect(audio.defaultPlaybackRate).toBe(1);
    expect(audio.playbackRate).toBe(1);
    expect(audio.preservesPitch).toBe(true);
    engine.setSource("transcription");
    vi.advanceTimersByTime(10);
    expect(audio.volume).toBeCloseTo(0);
    engine.setSource("original");
    vi.advanceTimersByTime(10);
    expect(audio.volume).toBeCloseTo(1);

    engine.pause();
    await engine.destroy();
  });

  it("does not restart active notes when transcription results arrive", async () => {
    vi.useFakeTimers();
    const { audio, engine } = await createTestEngine();
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
    const activeNote = note("active", piano.id, 0.9, 2);

    engine.setProject([piano], [activeNote]);
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
    vi.advanceTimersByTime(25);
    expect(synthSpies.noteOn).toHaveBeenCalledTimes(2);

    engine.pause();
    await engine.destroy();
  });

  it("previews a selected note with its track instrument", async () => {
    vi.useFakeTimers();
    const { engine, gain } = await createTestEngine();
    const piano = track("piano");
    const selectedNote = note("selected", piano.id, 1, 2);
    engine.setProject([piano], [selectedNote]);

    await engine.previewNote(piano, selectedNote);

    expect(synthSpies.programChange).toHaveBeenLastCalledWith(0, 0);
    expect(synthSpies.noteOn).toHaveBeenCalledWith(0, 60, 100, {
      time: 0,
    });
    expect(synthSpies.noteOff).toHaveBeenCalledWith(0, 60, {
      time: 0.4,
    });
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 0.01);

    vi.advanceTimersByTime(400);
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 0.01);

    await engine.destroy();
  });
});
