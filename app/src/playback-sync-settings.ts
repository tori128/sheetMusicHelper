export const DEFAULT_SOURCE_PLAYBACK_DELAY_MS = 15;
export const MIN_SOURCE_PLAYBACK_DELAY_MS = -200;
export const MAX_SOURCE_PLAYBACK_DELAY_MS = 200;

const STORAGE_KEY = "earcopy-source-playback-delay-ms";

export function normalizeSourcePlaybackDelayMs(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SOURCE_PLAYBACK_DELAY_MS;
  }
  return Math.min(
    MAX_SOURCE_PLAYBACK_DELAY_MS,
    Math.max(MIN_SOURCE_PLAYBACK_DELAY_MS, Math.round(value)),
  );
}

export function splitPlaybackSynchronizationDelayMs(value: number): {
  sourceDelayMs: number;
  transcriptionDelayMs: number;
} {
  const normalized = normalizeSourcePlaybackDelayMs(value);
  return {
    sourceDelayMs: Math.max(0, normalized),
    transcriptionDelayMs: Math.max(0, -normalized),
  };
}

export function readSourcePlaybackDelayMs(): number {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null
      ? DEFAULT_SOURCE_PLAYBACK_DELAY_MS
      : normalizeSourcePlaybackDelayMs(Number(stored));
  } catch {
    return DEFAULT_SOURCE_PLAYBACK_DELAY_MS;
  }
}

export function writeSourcePlaybackDelayMs(value: number): number {
  const normalized = normalizeSourcePlaybackDelayMs(value);
  try {
    window.localStorage.setItem(STORAGE_KEY, String(normalized));
  } catch {
    // The value remains available in the current settings dialog.
  }
  return normalized;
}
