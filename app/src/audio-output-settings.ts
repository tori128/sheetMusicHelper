const AUDIO_OUTPUT_DEVICE_STORAGE_KEY = "earcopy-audio-output-device-id";

export function readAudioOutputDeviceId(): string {
  try {
    return (
      window.localStorage.getItem(AUDIO_OUTPUT_DEVICE_STORAGE_KEY)?.trim() ||
      "default"
    );
  } catch {
    return "default";
  }
}

export function writeAudioOutputDeviceId(deviceId: string): string {
  const normalized = deviceId.trim() || "default";
  try {
    window.localStorage.setItem(
      AUDIO_OUTPUT_DEVICE_STORAGE_KEY,
      normalized,
    );
  } catch {
    // Playback still uses the selection for the current session.
  }
  return normalized;
}
