import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportMenu } from "./ExportMenu";

describe("ExportMenu", () => {
  afterEach(cleanup);

  it("runs the selected export and closes the menu", () => {
    const onExportMidi = vi.fn();
    render(
      <ExportMenu
        exporting={null}
        stemsAvailable
        onExportMidi={onExportMidi}
        onExportMusicXml={vi.fn()}
        onExportStems={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "書き出し" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^MIDI/ }));

    expect(onExportMidi).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes with Escape and hides separated audio when unavailable", () => {
    render(
      <ExportMenu
        exporting={null}
        stemsAvailable={false}
        onExportMidi={vi.fn()}
        onExportMusicXml={vi.fn()}
        onExportStems={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "書き出し" }));
    expect(screen.queryByRole("menuitem", { name: /^分離音源/ })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
