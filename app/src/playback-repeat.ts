export type PlaybackRepeatMode = "off" | "all" | "ab";

export const MINIMUM_AB_REPEAT_DURATION_SEC = 0.1;
const REPEAT_DURATION_COMPARISON_EPSILON_SEC = 1e-9;

export interface PlaybackRepeatSettings {
  mode: PlaybackRepeatMode;
  aSec: number | null;
  bSec: number | null;
  fullStartSec: number;
  fullEndSec: number;
}

export interface PlaybackRepeatRange {
  startSec: number;
  endSec: number;
}

function finiteTime(timeSec: number | null): timeSec is number {
  return timeSec !== null && Number.isFinite(timeSec);
}

export function hasMinimumAbRepeatDuration(
  startSec: number,
  endSec: number,
): boolean {
  return (
    Number.isFinite(startSec) &&
    Number.isFinite(endSec) &&
    endSec - startSec >=
      MINIMUM_AB_REPEAT_DURATION_SEC - REPEAT_DURATION_COMPARISON_EPSILON_SEC
  );
}

export function resolvePlaybackRepeatRange(
  settings: PlaybackRepeatSettings,
): PlaybackRepeatRange | null {
  const fullStartSec = Number.isFinite(settings.fullStartSec)
    ? Math.max(0, settings.fullStartSec)
    : 0;
  const fullEndSec = Number.isFinite(settings.fullEndSec)
    ? Math.max(fullStartSec, settings.fullEndSec)
    : fullStartSec;

  if (settings.mode === "off") {
    return null;
  }
  if (settings.mode === "all") {
    return hasMinimumAbRepeatDuration(fullStartSec, fullEndSec)
      ? { startSec: fullStartSec, endSec: fullEndSec }
      : null;
  }
  if (!finiteTime(settings.aSec) || !finiteTime(settings.bSec)) {
    return null;
  }
  const startSec = Math.min(fullEndSec, Math.max(fullStartSec, settings.aSec));
  const endSec = Math.min(fullEndSec, Math.max(fullStartSec, settings.bSec));
  return hasMinimumAbRepeatDuration(startSec, endSec)
    ? { startSec, endSec }
    : null;
}

export function repeatStartAtPosition(
  positionSec: number,
  range: PlaybackRepeatRange | null,
): number | null {
  if (
    range === null ||
    !Number.isFinite(positionSec) ||
    positionSec < range.endSec
  ) {
    return null;
  }
  return range.startSec;
}
