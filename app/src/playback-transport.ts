export const PLAYBACK_START_LEAD_SEC = 0.005;

export interface PlaybackStartAnchor {
  contextTimeSec: number;
  sourceTimeSec: number;
  audibleContextTimeSec: number;
}

export interface TimelinePlaybackStartAnchor extends PlaybackStartAnchor {
  timelineTimeSec: number;
}

export function createPlaybackStartAnchor(
  contextTimeSec: number,
  sourceTimeSec: number,
): PlaybackStartAnchor {
  if (!Number.isFinite(contextTimeSec) || !Number.isFinite(sourceTimeSec)) {
    throw new Error("Playback start time must be finite");
  }
  return {
    contextTimeSec,
    sourceTimeSec,
    audibleContextTimeSec: contextTimeSec + PLAYBACK_START_LEAD_SEC,
  };
}

export function contextTimeForTimelineTime(
  anchor: Pick<
    TimelinePlaybackStartAnchor,
    "contextTimeSec" | "timelineTimeSec"
  >,
  timelineTimeSec: number,
): number {
  return (
    anchor.contextTimeSec +
    Math.max(0, timelineTimeSec - anchor.timelineTimeSec)
  );
}

export function timelineTimeAtContextTime(
  anchor: Pick<
    TimelinePlaybackStartAnchor,
    "contextTimeSec" | "timelineTimeSec"
  >,
  contextTimeSec: number,
): number {
  return (
    anchor.timelineTimeSec +
    Math.max(0, contextTimeSec - anchor.contextTimeSec)
  );
}
