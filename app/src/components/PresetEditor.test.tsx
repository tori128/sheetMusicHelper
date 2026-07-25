import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  InstrumentDefinition,
  PresetDefinition,
} from "../types";
import { PresetEditor } from "./PresetEditor";

const instruments: InstrumentDefinition[] = [
  {
    id: "acoustic_piano",
    displayNameJa: "ピアノ",
    kind: "pitched",
    gmProgram: 0,
  },
  {
    id: "electric_bass",
    displayNameJa: "ベース",
    kind: "pitched",
    gmProgram: 33,
  },
  {
    id: "drums",
    displayNameJa: "ドラム",
    kind: "drums",
    gmProgram: null,
  },
];

const preset: PresetDefinition = {
  id: "builtin",
  key: "builtin",
  name: "Band",
  trackCount: 2,
  tracks: [
    {
      displayName: "Piano",
      instrumentId: "acoustic_piano",
      color: "#112233",
      kind: "pitched",
      order: 1,
    },
    {
      displayName: "Bass",
      instrumentId: "electric_bass",
      color: "#445566",
      kind: "pitched",
      order: 2,
    },
  ],
};

describe("PresetEditor", () => {
  it("adds, reorders, deletes and saves a copied preset", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PresetEditor
        instruments={instruments}
        preset={preset}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText("プリセット名"), {
      target: { value: "My Band" },
    });
    fireEvent.click(screen.getByText("トラック追加"));
    expect(screen.getAllByLabelText("トラック名")).toHaveLength(3);
    fireEvent.click(screen.getAllByLabelText("上へ")[2]);
    fireEvent.click(screen.getAllByLabelText("削除")[0]);
    fireEvent.click(screen.getByText("別名保存"));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [name, tracks] = onSave.mock.calls[0];
    expect(name).toBe("My Band");
    expect(tracks).toHaveLength(2);
    expect(tracks.map((track: { order: number }) => track.order)).toEqual([
      1, 2,
    ]);
  });
});
