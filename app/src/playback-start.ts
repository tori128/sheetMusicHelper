import { sourceTimeToTimelineTime } from "./soundfont-playback";
import type {
  PlaybackStartAnchor,
  TimelinePlaybackStartAnchor,
} from "./playback-transport";

interface PlaybackAudioElement {
  readonly currentTime: number;
  play(): Promise<void>;
  pause(): void;
}

interface SourcePlaybackStart {
  prepare(): Promise<void>;
  primeStart(sourceTimeSec?: number): Promise<PlaybackStartAnchor>;
  activateAt(anchor: PlaybackStartAnchor): void;
  pause(): void;
}

interface SoundFontPlaybackStart {
  prepare(): Promise<void>;
  pause(): void;
  start(): Promise<void>;
  startAt(anchor: TimelinePlaybackStartAnchor): void;
}

interface PlaybackStartRequest {
  audio: PlaybackAudioElement;
  sourceMixer: SourcePlaybackStart | null;
  engine: SoundFontPlaybackStart | null;
  timelineOffsetSec: number;
}

function pausePlaybackPaths(request: PlaybackStartRequest): void {
  request.audio.pause();
  request.sourceMixer?.pause();
  request.engine?.pause();
}

/**
 * Serializes playback starts and lets only the latest request activate audio.
 *
 * Source preparation and SoundFont preparation are asynchronous. Without one
 * coordinator, a slower request can activate after a later seek or mode change.
 */
export class PlaybackStartCoordinator {
  #requestId = 0;
  #pending: Promise<void> = Promise.resolve();

  cancel(): void {
    this.#requestId += 1;
  }

  start(request: PlaybackStartRequest): Promise<boolean> {
    const requestId = ++this.#requestId;
    const result = this.#pending.then(() =>
      this.#startCurrentRequest(requestId, request),
    );
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #startCurrentRequest(
    requestId: number,
    request: PlaybackStartRequest,
  ): Promise<boolean> {
    if (requestId !== this.#requestId) {
      return false;
    }
    const { audio, sourceMixer, engine, timelineOffsetSec } = request;
    try {
      if (sourceMixer !== null) {
        engine?.pause();
        await Promise.all([sourceMixer.prepare(), engine?.prepare()]);
        if (requestId !== this.#requestId) {
          return false;
        }
        await audio.play();
        if (requestId !== this.#requestId) {
          pausePlaybackPaths(request);
          return false;
        }
        const anchor = await sourceMixer.primeStart(audio.currentTime);
        if (requestId !== this.#requestId) {
          pausePlaybackPaths(request);
          return false;
        }
        engine?.startAt({
          ...anchor,
          timelineTimeSec: sourceTimeToTimelineTime(
            anchor.sourceTimeSec,
            timelineOffsetSec,
          ),
        });
        sourceMixer.activateAt(anchor);
        return true;
      }

      await audio.play();
      if (requestId !== this.#requestId) {
        pausePlaybackPaths(request);
        return false;
      }
      await engine?.start();
      if (requestId !== this.#requestId) {
        pausePlaybackPaths(request);
        return false;
      }
      return true;
    } catch (reason) {
      pausePlaybackPaths(request);
      throw reason;
    }
  }
}
