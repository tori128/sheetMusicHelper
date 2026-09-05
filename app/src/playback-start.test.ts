import { describe, expect, it, vi } from "vitest";
import { PlaybackStartCoordinator } from "./playback-start";

function createAudio(calls: string[], currentTime = 7) {
  return {
    currentTime,
    play: vi.fn(async () => {
      calls.push("audio.play");
    }),
    pause: vi.fn(() => {
      calls.push("audio.pause");
    }),
  };
}

function createEngine(calls: string[]) {
  return {
    prepare: vi.fn(async () => {
      calls.push("engine.prepare");
    }),
    pause: vi.fn(() => {
      calls.push("engine.pause");
    }),
    startAt: vi.fn(() => {
      calls.push("engine.startAt");
    }),
    start: vi.fn(async () => {
      calls.push("engine.start");
    }),
  };
}

function createSourceMixer(calls: string[], sourceTimeSec = 7) {
  const anchor = {
    contextTimeSec: 3,
    sourceTimeSec,
    audibleContextTimeSec: 3.05,
  };
  return {
    anchor,
    prepare: vi.fn(async () => {
      calls.push("source.prepare");
    }),
    primeStart: vi.fn(async () => {
      calls.push("source.prime");
      return anchor;
    }),
    activateAt: vi.fn(() => {
      calls.push("source.activate");
    }),
    pause: vi.fn(() => {
      calls.push("source.pause");
    }),
    seek: vi.fn((sourceTimeSec: number) => {
      calls.push(`source.seek:${sourceTimeSec}`);
    }),
  };
}

describe("PlaybackStartCoordinator", () => {
  it("uses one anchor for Wave gain and SoundFont scheduling", async () => {
    const calls: string[] = [];
    const audio = createAudio(calls);
    const sourceMixer = createSourceMixer(calls);
    const engine = createEngine(calls);
    const coordinator = new PlaybackStartCoordinator();

    const started = await coordinator.start({
      audio,
      sourceMixer,
      engine,
      timelineOffsetSec: 0.25,
    });

    expect(started).toBe(true);
    expect(calls).toEqual([
      "engine.pause",
      "audio.pause",
      "source.seek:7",
      "source.prepare",
      "engine.prepare",
      "audio.play",
      "source.prime",
      "engine.startAt",
      "source.activate",
    ]);
    expect(sourceMixer.primeStart).toHaveBeenCalledWith(audio.currentTime);
    expect(engine.startAt).toHaveBeenCalledWith({
      ...sourceMixer.anchor,
      timelineTimeSec: 7.25,
    });
    expect(sourceMixer.activateAt).toHaveBeenCalledWith(sourceMixer.anchor);
  });

  it("keeps the source position unchanged while PCM is prepared", async () => {
    const calls: string[] = [];
    const audio = createAudio(calls, 5);
    const sourceMixer = createSourceMixer(calls, 5);
    sourceMixer.prepare.mockImplementation(async () => {
      calls.push("source.prepare");
      audio.currentTime = 10;
    });
    sourceMixer.primeStart.mockImplementation(async (sourceTimeSec?: number) => {
      calls.push("source.prime");
      return {
        contextTimeSec: 3,
        sourceTimeSec: sourceTimeSec ?? 0,
        audibleContextTimeSec: 3.05,
      };
    });
    const engine = createEngine(calls);
    const coordinator = new PlaybackStartCoordinator();

    await expect(
      coordinator.start({
        audio,
        sourceMixer,
        engine,
        timelineOffsetSec: 0.2,
      }),
    ).resolves.toBe(true);

    expect(sourceMixer.seek).toHaveBeenCalledWith(5);
    expect(sourceMixer.primeStart).toHaveBeenCalledWith(5);
    expect(engine.startAt).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTimeSec: 5,
        timelineTimeSec: 5.2,
      }),
    );
  });

  it("keeps direct Wave playback available without a shared graph", async () => {
    const calls: string[] = [];
    const audio = createAudio(calls);
    const coordinator = new PlaybackStartCoordinator();

    const started = await coordinator.start({
      audio,
      sourceMixer: null,
      engine: null,
      timelineOffsetSec: 0,
    });

    expect(started).toBe(true);
    expect(calls).toEqual(["audio.play"]);
  });

  it("starts SoundFont playback without a source mixer", async () => {
    const calls: string[] = [];
    const audio = createAudio(calls);
    const engine = createEngine(calls);
    const coordinator = new PlaybackStartCoordinator();

    const started = await coordinator.start({
      audio,
      sourceMixer: null,
      engine,
      timelineOffsetSec: 0,
    });

    expect(started).toBe(true);
    expect(calls).toEqual(["audio.play", "engine.start"]);
  });

  it("activates only the latest request when an earlier preparation is pending", async () => {
    const calls: string[] = [];
    let finishPreparation: (() => void) | undefined;
    const firstMixer = createSourceMixer(calls, 1);
    firstMixer.prepare.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const secondMixer = createSourceMixer(calls, 2);
    const engine = createEngine(calls);
    const audio = createAudio(calls);
    const coordinator = new PlaybackStartCoordinator();

    const first = coordinator.start({
      audio,
      sourceMixer: firstMixer,
      engine,
      timelineOffsetSec: 0,
    });
    await vi.waitFor(() => expect(finishPreparation).toBeTypeOf("function"));
    const second = coordinator.start({
      audio,
      sourceMixer: secondMixer,
      engine,
      timelineOffsetSec: 0,
    });
    finishPreparation?.();

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(firstMixer.primeStart).not.toHaveBeenCalled();
    expect(secondMixer.primeStart).toHaveBeenCalledOnce();
    expect(engine.startAt).toHaveBeenCalledOnce();
    expect(engine.startAt).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTimeSec: 2 }),
    );
  });

  it("cancels a pending request before it activates playback", async () => {
    const calls: string[] = [];
    let finishPreparation: (() => void) | undefined;
    const sourceMixer = createSourceMixer(calls);
    sourceMixer.prepare.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const coordinator = new PlaybackStartCoordinator();
    const request = coordinator.start({
      audio: createAudio(calls),
      sourceMixer,
      engine: createEngine(calls),
      timelineOffsetSec: 0,
    });
    await vi.waitFor(() => expect(finishPreparation).toBeTypeOf("function"));

    coordinator.cancel();
    finishPreparation?.();

    await expect(request).resolves.toBe(false);
    expect(sourceMixer.primeStart).not.toHaveBeenCalled();
    expect(calls).not.toContain("audio.play");
  });

  it("pauses every path when SoundFont activation fails", async () => {
    const calls: string[] = [];
    const audio = createAudio(calls);
    const sourceMixer = createSourceMixer(calls);
    const engine = createEngine(calls);
    engine.startAt.mockImplementation(() => {
      calls.push("engine.startAt");
      throw new Error("activation failed");
    });
    const coordinator = new PlaybackStartCoordinator();

    await expect(
      coordinator.start({
        audio,
        sourceMixer,
        engine,
        timelineOffsetSec: 0,
      }),
    ).rejects.toThrow("activation failed");
    expect(audio.pause).toHaveBeenCalledTimes(2);
    expect(sourceMixer.pause).toHaveBeenCalledOnce();
    expect(engine.pause).toHaveBeenCalledTimes(2);
    expect(sourceMixer.activateAt).not.toHaveBeenCalled();
  });
});
