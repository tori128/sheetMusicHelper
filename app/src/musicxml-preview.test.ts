import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMusicXmlPreviewDocument,
  MUSICXML_PREVIEW_ERROR_MESSAGE,
  MUSICXML_PREVIEW_MEASURE_LIMIT,
  renderMusicXmlPreview,
} from "./musicxml-preview";

const { constructorSpy, loadSpy, renderSpy } = vi.hoisted(() => ({
  constructorSpy: vi.fn(),
  loadSpy: vi.fn(async (_musicXml: string) => undefined),
  renderSpy: vi.fn(),
}));

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: class {
    constructor(container: HTMLElement, options: Record<string, unknown>) {
      constructorSpy(container, options);
    }

    load(musicXml: string) {
      return loadSpy(musicXml);
    }

    render() {
      renderSpy();
    }
  },
}));

describe("renderMusicXmlPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes only the configured number of measures to the renderer", async () => {
    const container = document.createElement("div");
    const measures = Array.from(
      { length: MUSICXML_PREVIEW_MEASURE_LIMIT + 2 },
      (_, index) => `<measure number="${index + 1}"/>`,
    ).join("");
    const musicXml = `<score-partwise><part-list/><part id="P1">${measures}</part><part id="P2">${measures}</part></score-partwise>`;

    await renderMusicXmlPreview(container, musicXml);

    const previewXml = loadSpy.mock.calls[0]?.[0];
    expect(previewXml).toBeDefined();
    expect(previewXml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(previewXml?.match(/<\?xml/g)).toHaveLength(1);
    const previewDocument = new DOMParser().parseFromString(
      previewXml ?? "",
      "application/xml",
    );
    const parts = Array.from(previewDocument.querySelectorAll("part"));
    expect(parts).toHaveLength(2);
    expect(parts.map((part) => part.querySelectorAll("measure").length)).toEqual([
      MUSICXML_PREVIEW_MEASURE_LIMIT,
      MUSICXML_PREVIEW_MEASURE_LIMIT,
    ]);
    expect(previewXml).not.toContain('number="17"');
    expect(constructorSpy).toHaveBeenCalledWith(
      container,
      expect.objectContaining({
        backend: "svg",
        drawUpToMeasureNumber: MUSICXML_PREVIEW_MEASURE_LIMIT,
      }),
    );
    expect(renderSpy).toHaveBeenCalledOnce();
  });

  it("rejects malformed MusicXML before creating the renderer", () => {
    expect(() => createMusicXmlPreviewDocument("<score-partwise>"))
      .toThrow("MusicXMLを読み込めませんでした");
  });

  it("does not create a renderer after the preview is closed", async () => {
    const container = document.createElement("div");

    await renderMusicXmlPreview(container, "<score-partwise/>", () => true);

    expect(constructorSpy).not.toHaveBeenCalled();
    expect(loadSpy).not.toHaveBeenCalled();
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("does not render after the preview is closed while MusicXML is loading", async () => {
    let resolveLoad!: () => void;
    loadSpy.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveLoad = () => resolve(undefined);
        }),
    );
    const container = document.createElement("div");
    let cancelled = false;

    const rendering = renderMusicXmlPreview(
      container,
      "<score-partwise/>",
      () => cancelled,
    );
    await vi.waitFor(() => expect(loadSpy).toHaveBeenCalledOnce());
    cancelled = true;
    resolveLoad();
    await rendering;

    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("does not expose the renderer error message", async () => {
    loadSpy.mockRejectedValueOnce(
      new Error("OpenSheetMusicDisplay: The document which was provided is invalid"),
    );
    const container = document.createElement("div");

    await expect(
      renderMusicXmlPreview(container, "<score-partwise/>")
    ).rejects.toThrow(MUSICXML_PREVIEW_ERROR_MESSAGE);
  });
});
