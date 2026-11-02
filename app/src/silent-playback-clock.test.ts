import { describe, expect, it } from "vitest";
import { createSilentPlaybackWav } from "./silent-playback-clock";

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

describe("createSilentPlaybackWav", () => {
  it("creates an 8 kHz mono clock with the requested duration", () => {
    const bytes = createSilentPlaybackWav(2.5);
    const view = new DataView(bytes.buffer);

    expect(ascii(bytes, 0, 4)).toBe("RIFF");
    expect(ascii(bytes, 8, 4)).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(8_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(8);
    expect(view.getUint32(40, true)).toBe(20_000);
    expect(bytes.byteLength).toBe(20_044);
    expect(bytes[44]).toBe(128);
    expect(bytes.at(-1)).toBe(128);
  });
});
