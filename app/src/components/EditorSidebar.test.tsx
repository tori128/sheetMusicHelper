import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSidebar } from "./EditorSidebar";

const baseProps = {
  tracks: [],
  stems: [],
  trackControlsDisabled: false,
  stemControlsDisabled: false,
  originalAudioMuted: false,
  noteCount: 0,
  selectedNoteCount: 0,
  bpm: 120,
  beatOffsetSec: 0,
  quantizeGrid: "1/16" as const,
  noteShiftMs: 0,
  editingLocked: false,
  canUndo: false,
  canRedo: false,
  onMute: vi.fn(),
  onSolo: vi.fn(),
  onStemMute: vi.fn(),
  onStemSolo: vi.fn(),
  onPlaybackOctaveShift: vi.fn(),
  onPlaybackVolume: vi.fn(),
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  onDeleteSelected: vi.fn(),
  canPaste: false,
  onCopySelected: vi.fn(),
  onPaste: vi.fn(),
  onSplitSelected: vi.fn(),
  onJoinSelected: vi.fn(),
  onSetSelectedDuration: vi.fn(),
  onScaleTempo: vi.fn(),
  onSetMeasureStart: vi.fn(),
  onQuantizeGridChange: vi.fn(),
  onQuantize: vi.fn(),
  onNoteShiftMsChange: vi.fn(),
  onShiftMilliseconds: vi.fn(),
  onShiftBeats: vi.fn(),
};

describe("EditorSidebar", () => {
  afterEach(cleanup);

  it("shows the original audio below transcription tracks when stems are absent", () => {
    render(<EditorSidebar {...baseProps} />);

    const trackList = screen.getByRole("region", { name: "トラック一覧" });
    const originalAudioList = screen.getByRole("region", { name: "原音" });

    expect(within(originalAudioList).getByText("音源")).toBeVisible();
    expect(within(originalAudioList).getByText("原音")).toBeVisible();
    expect(
      within(originalAudioList).getByRole("button", {
        name: "原音のミュート状態",
      }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(originalAudioList).getByRole("button", {
        name: "原音のソロ状態",
      }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      trackList.compareDocumentPosition(originalAudioList) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "分離音源一覧" }),
    ).not.toBeInTheDocument();
  });

  it("shows the original audio as muted in transcription mode", () => {
    render(<EditorSidebar {...baseProps} originalAudioMuted />);

    expect(
      screen.getByRole("button", { name: "原音のミュート状態" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("changes tempo by half or double and disables out-of-range factors", () => {
    const onScaleTempo = vi.fn();
    const { rerender } = render(
      <EditorSidebar {...baseProps} onScaleTempo={onScaleTempo} />,
    );

    fireEvent.click(document.getElementById("edit-tab")!);
    fireEvent.click(screen.getByRole("button", { name: "テンポを半分" }));
    fireEvent.click(screen.getByRole("button", { name: "テンポを2倍" }));
    expect(onScaleTempo.mock.calls).toEqual([[0.5], [2]]);

    rerender(
      <EditorSidebar
        {...baseProps}
        bpm={160}
        onScaleTempo={onScaleTempo}
      />,
    );
    expect(
      screen.getByRole("button", { name: "テンポを2倍" }),
    ).toBeDisabled();

    rerender(
      <EditorSidebar
        {...baseProps}
        bpm={30}
        onScaleTempo={onScaleTempo}
      />,
    );
    expect(
      screen.getByRole("button", { name: "テンポを半分" }),
    ).toBeDisabled();
  });

  it("allows deletion but locks timeline edits while transcription is running", () => {
    render(
      <EditorSidebar
        {...baseProps}
        noteCount={4}
        selectedNoteCount={1}
        noteShiftMs={10}
        canUndo
        canRedo
        editingLocked
      />,
    );

    fireEvent.click(document.getElementById("edit-tab")!);
    expect(screen.getByRole("status")).toHaveTextContent(
      "採譜中はノートの追加、削除、パート移動を使用できます",
    );
    const panel = screen.getByRole("tabpanel");
    const deleteButton = within(panel).getByRole("button", {
      name: "選択ノートを削除",
    });
    expect(deleteButton).toBeEnabled();
    for (const button of within(panel)
      .getAllByRole("button")
      .filter(
        (candidate) =>
          candidate !== deleteButton &&
          candidate.getAttribute("title") !== "選択ノートをコピー (Ctrl+C)",
      )) {
      expect(button).toBeDisabled();
    }
    for (const select of within(panel).getAllByRole("combobox")) {
      expect(select).toBeDisabled();
    }
    expect(within(panel).getByRole("spinbutton")).toBeDisabled();
  });

  it("moves only the selected track when a track scope is chosen", () => {
    const onShiftMilliseconds = vi.fn();
    render(
      <EditorSidebar
        {...baseProps}
        tracks={[
          {
            id: "vocal-track",
            displayName: "Vocal",
            instrumentId: "voice",
            kind: "pitched",
            color: "#36B37E",
            order: 1,
            midiChannel: 1,
            gmProgram: 71,
            playbackOctaveShift: 0,
            playbackVolume: 100,
            mute: false,
            solo: false,
          },
        ]}
        noteCount={1}
        noteShiftMs={50}
        onShiftMilliseconds={onShiftMilliseconds}
      />,
    );

    fireEvent.click(document.getElementById("edit-tab")!);
    fireEvent.change(
      screen.getByRole("combobox", { name: "位置移動の対象トラック" }),
      { target: { value: "vocal-track" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "移動" }));

    expect(onShiftMilliseconds).toHaveBeenCalledWith("vocal-track");
  });
});
