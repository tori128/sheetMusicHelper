export function formatPlaybackTime(timeSec: number): string {
  const normalized = Math.max(0, Number.isFinite(timeSec) ? timeSec : 0);
  const minutes = Math.floor(normalized / 60);
  const seconds = Math.floor(normalized % 60);
  const milliseconds = Math.floor((normalized % 1) * 1000);
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
}
