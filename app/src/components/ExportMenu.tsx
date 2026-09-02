import { useEffect, useRef, useState } from "react";
import { Localized } from "../i18n";
import {
  AudioLines,
  ChevronDown,
  Download,
  FileCode2,
  FileMusic,
} from "lucide-react";

interface ExportMenuProps {
  exporting: "midi" | "musicxml" | "stems" | null;
  stemsAvailable: boolean;
  onExportMidi(): void;
  onExportMusicXml(): void;
  onExportStems(): void;
}

export function ExportMenu({
  exporting,
  stemsAvailable,
  onExportMidi,
  onExportMusicXml,
  onExportStems,
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeFromPointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeFromPointer);
    window.addEventListener("keydown", closeFromKeyboard);
    return () => {
      window.removeEventListener("pointerdown", closeFromPointer);
      window.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <Localized>
    <div className="export-menu" ref={containerRef}>
      <button
        type="button"
        className="secondary-button button-with-icon"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={exporting !== null}
        onClick={() => setOpen((current) => !current)}
      >
        <Download size={15} aria-hidden="true" />
        <span>{exporting === null ? "書き出し" : "書き出し中…"}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="export-menu__popup" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => run(onExportMidi)}
          >
            <FileMusic size={17} aria-hidden="true" />
            <span>MIDI</span>
            <small>.mid</small>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => run(onExportMusicXml)}
          >
            <FileCode2 size={17} aria-hidden="true" />
            <span>MusicXML</span>
            <small>.musicxml</small>
          </button>
          {stemsAvailable && (
            <button
              type="button"
              role="menuitem"
              onClick={() => run(onExportStems)}
            >
              <AudioLines size={17} aria-hidden="true" />
              <span>分離音源</span>
              <small>.wav</small>
            </button>
          )}
        </div>
      )}
    </div>
    </Localized>
  );
}
