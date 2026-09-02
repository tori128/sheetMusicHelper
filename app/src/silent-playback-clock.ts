const SAMPLE_RATE = 8_000;
const WAV_HEADER_SIZE = 44;
const SILENCE_SAMPLE = 128;

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function createSilentPlaybackWav(
  durationSec: number,
): Uint8Array<ArrayBuffer> {
  const normalizedDurationSec = Number.isFinite(durationSec)
    ? Math.max(0.01, durationSec)
    : 0.01;
  const sampleCount = Math.max(
    1,
    Math.ceil(normalizedDurationSec * SAMPLE_RATE),
  );
  const bytes = new Uint8Array(WAV_HEADER_SIZE + sampleCount);
  const view = new DataView(bytes.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount, true);
  bytes.fill(SILENCE_SAMPLE, WAV_HEADER_SIZE);
  return bytes;
}

export function createSilentPlaybackUrl(durationSec: number): string {
  const wav = createSilentPlaybackWav(durationSec);
  return URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
}
