import { describe, expect, it, vi } from "vitest";
import { runMusicXmlPreviewSmoke } from "./musicxml-preview";

describe("OpenSheetMusicDisplay integration", () => {
  it("loads the installed library and renders MusicXML as SVG", async () => {
    const canvas = document.createElement("canvas");
    const canvasContext = new Proxy(
      {
        canvas,
        font: "",
        measureText: (text: string) => ({
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: text.length * 8,
          width: text.length * 8,
        }),
        getImageData: (_x: number, _y: number, width: number, height: number) => ({
          colorSpace: "srgb",
          data: new Uint8ClampedArray(Math.max(0, width * height * 4)),
          height,
          width,
        }),
      },
      {
        get(target, property, receiver) {
          return Reflect.has(target, property)
            ? Reflect.get(target, property, receiver)
            : () => undefined;
        },
      },
    ) as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => canvasContext,
    );
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return Number.parseFloat(this.style.width) || 1200;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 800;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return Number.parseFloat(this.style.width) || 1200;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 800;
      },
    );

    const result = await runMusicXmlPreviewSmoke();

    expect(result.svgCount).toBeGreaterThanOrEqual(1);
    expect(result.graphicalElementCount).toBeGreaterThanOrEqual(1);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
