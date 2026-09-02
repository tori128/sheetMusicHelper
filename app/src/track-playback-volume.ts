import { MIDIControllers } from "spessasynth_core";
import type { ProjectTrack } from "./types";

export const DEFAULT_TRACK_PLAYBACK_VOLUME = 100;
export const MIN_TRACK_PLAYBACK_VOLUME = 0;
export const MAX_TRACK_PLAYBACK_VOLUME = 100;

export function trackPlaybackVolume(track: ProjectTrack): number {
  return track.playbackVolume;
}

export function trackMidiVolume(track: ProjectTrack): {
  controller: typeof MIDIControllers.mainVolume;
  value: number;
} {
  return {
    controller: MIDIControllers.mainVolume,
    value: Math.round(trackPlaybackVolume(track)),
  };
}
