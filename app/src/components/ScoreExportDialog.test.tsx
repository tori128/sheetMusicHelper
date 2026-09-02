import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDocument, ScoreValidationResult } from "../types";
import { ScoreExportDialog } from "./ScoreExportDialog";

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: class {
    load() {
      return Promise.resolve();
    }
    render() {}
  },
}));

const project = {
  name: "Score",
  tracks: [],
  notes: [],
  tempo: {
    ppq: 480,
    bpm: 120,
    beatOffsetSec: 0,
    quantizeGrid: "1/16",
    timeSignature: { numerator: 4, denominator: 4 },
  },
  score: {
    composer: "",
    arranger: "",
    copyright: "",
    keyFifths: 0,
    keyMode: "major",
    pickupTicks: 0,
    includeChordSymbols: true,
    chords: [],
    trackSettings: {},
  },
} as unknown as ProjectDocument;

const validation: ScoreValidationResult = {
  issues: [
    {
      code: "off_grid",
      severity: "warning",
      message: "開始位置を確認してください",
      trackId: "track-1",
      noteIds: ["note-1"],
      timeSec: 1,
      measureNumber: 2,
      beatNumber: 1,
    },
  ],
  errorCount: 0,
  warningCount: 1,
};

describe("ScoreExportDialog", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the export XML and opens a selected validation issue", async () => {
    const onSelectIssue = vi.fn();
    const onExport = vi.fn();
    const onQuantizeGridChange = vi.fn();
    render(
      <ScoreExportDialog
        project={project}
        validation={validation}
        musicXml={'<?xml version="1.0"?><score-partwise/>'}
        loading={false}
        quantizeGrid="1/16"
        onChange={vi.fn()}
        onQuantizeGridChange={onQuantizeGridChange}
        onRefresh={vi.fn()}
        onSelectIssue={onSelectIssue}
        onExport={onExport}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /2\.1.*開始位置/ }));
    expect(onSelectIssue).toHaveBeenCalledWith(validation.issues[0]);

    fireEvent.change(screen.getByLabelText("書き出す音符の分解能"), {
      target: { value: "1/8" },
    });
    expect(onQuantizeGridChange).toHaveBeenCalledWith("1/8");

    fireEvent.click(screen.getByRole("button", { name: "MusicXML書き出し" }));
    expect(onExport).toHaveBeenCalledOnce();

    expect(screen.getByTitle("閉じる")).toHaveClass(
      "secondary-button",
      "icon-button",
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("score-export-dialog");
    expect(dialog.parentElement).toHaveClass("score-export-backdrop");
  });
});
