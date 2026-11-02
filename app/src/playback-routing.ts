import type { PlaybackSource } from "./soundfont-playback";

export interface PlaybackRoutingRequest {
  source: PlaybackSource;
  sourceMixEnabled: boolean;
  transcriptionMixEnabled: boolean;
  metronomeEnabled: boolean;
}

export interface PlaybackRouting {
  source: PlaybackSource;
  soundFontSource: PlaybackSource;
  sourceMixerSource: PlaybackSource;
  synchronized: boolean;
  usesAudioContextClock: boolean;
  requiresSoundFont: boolean;
}

export function resolvePlaybackRouting(
  request: PlaybackRoutingRequest,
): PlaybackRouting {
  const soundFontSource =
    request.source === "original" && request.transcriptionMixEnabled
      ? "transcription"
      : request.source;
  const sourceMixerSource =
    request.source === "transcription" && request.sourceMixEnabled
      ? "original"
      : request.source;
  const synchronized =
    request.source === "comparison" ||
    request.sourceMixEnabled ||
    request.transcriptionMixEnabled ||
    request.metronomeEnabled;
  return {
    source: request.source,
    soundFontSource,
    sourceMixerSource,
    synchronized,
    usesAudioContextClock:
      synchronized || soundFontSource !== "original",
    requiresSoundFont:
      request.source !== "original" ||
      request.transcriptionMixEnabled ||
      request.metronomeEnabled,
  };
}

export function requiresSourceMixer(
  routing: PlaybackRouting,
  sourceMixerInitialized: boolean,
  stemsHaveMuteOrSolo: boolean,
): boolean {
  return (
    sourceMixerInitialized ||
    routing.synchronized ||
    (routing.source === "original" && stemsHaveMuteOrSolo)
  );
}

export function isPlaybackActive(
  rendererStatePlaying: boolean,
  mediaElementPaused: boolean,
  sourceMixerPlaying: boolean,
): boolean {
  return rendererStatePlaying || !mediaElementPaused || sourceMixerPlaying;
}
