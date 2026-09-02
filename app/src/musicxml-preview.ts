const SMOKE_MUSIC_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <!--${"preview-document-size-check".repeat(100)}-->
  <work><work-title>MusicXML preview test</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>480</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>480</duration><voice>1</voice><type>quarter</type>
      </note>
      <note>
        <rest/><duration>1440</duration><voice>1</voice><type>half</type><dot/>
      </note>
    </measure>
  </part>
</score-partwise>`;

export const MUSICXML_PREVIEW_MEASURE_LIMIT = 16;
export const MUSICXML_PREVIEW_ERROR_MESSAGE =
  "MusicXMLプレビューを表示できませんでした";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

export function createMusicXmlPreviewDocument(musicXml: string): string {
  const document = new DOMParser().parseFromString(musicXml, "application/xml");
  if (document.querySelector("parsererror") !== null) {
    throw new Error("MusicXMLを読み込めませんでした");
  }
  for (const part of Array.from(document.querySelectorAll("score-partwise > part"))) {
    const measures = Array.from(part.children).filter(
      (element) => element.localName === "measure",
    );
    for (const measure of measures.slice(MUSICXML_PREVIEW_MEASURE_LIMIT)) {
      measure.remove();
    }
  }
  const serialized = new XMLSerializer().serializeToString(document);
  return `${XML_DECLARATION}\n${serialized.replace(/^<\?xml[^?]*\?>\s*/i, "")}`;
}

export async function renderMusicXmlPreview(
  container: HTMLElement,
  musicXml: string,
  cancelled: () => boolean = () => false,
): Promise<void> {
  const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");
  if (cancelled()) {
    return;
  }
  const renderer = new OpenSheetMusicDisplay(container, {
    autoResize: true,
    backend: "svg",
    drawTitle: true,
    drawUpToMeasureNumber: MUSICXML_PREVIEW_MEASURE_LIMIT,
    drawingParameters: "compacttight",
  });
  try {
    await renderer.load(createMusicXmlPreviewDocument(musicXml));
    if (!cancelled()) {
      renderer.render();
    }
  } catch {
    throw new Error(MUSICXML_PREVIEW_ERROR_MESSAGE);
  }
}

export async function runMusicXmlPreviewSmoke(
  musicXml = SMOKE_MUSIC_XML,
): Promise<{
  svgCount: number;
  graphicalElementCount: number;
  elapsedMs: number;
}> {
  const startedAt = performance.now();
  const container = document.createElement("div");
  container.style.width = "1200px";
  container.style.height = "800px";
  container.style.position = "fixed";
  container.style.left = "-2000px";
  document.body.append(container);
  try {
    await renderMusicXmlPreview(container, musicXml);
    return {
      svgCount: container.querySelectorAll("svg").length,
      graphicalElementCount: container.querySelectorAll("svg path, svg text, svg g")
        .length,
      elapsedMs: performance.now() - startedAt,
    };
  } finally {
    container.remove();
  }
}
