export const TRACK_COLOR_PALETTE = [
  "#4C9AFF",
  "#E85AAD",
  "#FFAB00",
  "#36B37E",
  "#FF7452",
  "#7A5AF8",
  "#00B8D9",
  "#FF8B00",
  "#9CC4FF",
  "#F39ACB",
  "#FFE380",
  "#79F2C0",
  "#FFBDAD",
  "#B8A7FF",
  "#82E9F4",
  "#FFC875",
] as const;

function colorKey(color: string): string {
  return color.toUpperCase();
}

export function isPaletteColor(color: string): boolean {
  const key = colorKey(color);
  return TRACK_COLOR_PALETTE.some((candidate) => candidate === key);
}

export function nextTrackColor(colors: Iterable<string>): string {
  const used = new Set([...colors].map(colorKey));
  return (
    TRACK_COLOR_PALETTE.find((color) => !used.has(color)) ??
    TRACK_COLOR_PALETTE[0]
  );
}

export function ensureUniqueTrackColors<T extends { color: string }>(
  tracks: readonly T[],
): T[] {
  const used = new Set<string>();
  return tracks.map((track) => {
    const key = colorKey(track.color);
    const color = used.has(key) ? nextTrackColor(used) : track.color;
    used.add(colorKey(color));
    return { ...track, color };
  });
}
