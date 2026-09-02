import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  InstrumentDefinition,
  PresetDefinition,
} from "../types";
import { PresetEditor } from "./PresetEditor";

afterEach(cleanup);

const instruments: InstrumentDefinition[] = [
  {
    id: "acoustic_piano",
    displayNameJa: "ピアノ",
    kind: "pitched",
    gmProgram: 0,
    gmPrograms: [
      { program: 0, displayNameJa: "グランドピアノ" },
      { program: 1, displayNameJa: "ブライトピアノ" },
    ],
  },
  {
    id: "electric_bass",
    displayNameJa: "ベース",
    kind: "pitched",
    gmProgram: 33,
    gmPrograms: [
      { program: 33, displayNameJa: "フィンガーベース" },
      { program: 34, displayNameJa: "ピックベース" },
    ],
  },
  {
    id: "drums",
    displayNameJa: "ドラム",
    kind: "drums",
    gmProgram: null,
    gmPrograms: [],
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
    const onSaveAs = vi.fn().mockResolvedValue(undefined);
    render(
      <PresetEditor
        instruments={instruments}
        preset={preset}
        onCancel={vi.fn()}
        onSaveAs={onSaveAs}
        onOverwrite={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("プリセット名"), {
      target: { value: "My Band" },
    });
    fireEvent.click(screen.getByText("トラック追加"));
    expect(screen.getAllByLabelText("トラック名")).toHaveLength(3);
    fireEvent.click(screen.getAllByLabelText("上へ")[2]);
    const deleteButton = screen.getAllByLabelText("削除")[0];
    expect(deleteButton).toHaveClass("preset-track-delete");
    fireEvent.click(deleteButton);
    fireEvent.click(screen.getByText("別名保存"));

    await waitFor(() => expect(onSaveAs).toHaveBeenCalledTimes(1));
    const [name, tracks] = onSaveAs.mock.calls[0];
    expect(name).toBe("My Band");
    expect(tracks).toHaveLength(2);
    expect(tracks.map((track: { order: number }) => track.order)).toEqual([
      1, 2,
    ]);
  });

  it("keeps the selected GM program and replaces duplicate automatic colors", async () => {
    const onSaveAs = vi.fn().mockResolvedValue(undefined);
    render(
      <PresetEditor
        instruments={instruments}
        preset={{
          ...preset,
          tracks: preset.tracks.map((track) => ({
            ...track,
            color: "#4C9AFF",
          })),
        }}
        onCancel={vi.fn()}
        onSaveAs={onSaveAs}
        onOverwrite={vi.fn()}
      />,
    );

    const toneSelectors = screen.getAllByLabelText("再生音色");
    fireEvent.change(toneSelectors[0], { target: { value: "1" } });
    fireEvent.click(screen.getByText("別名保存"));

    await waitFor(() => expect(onSaveAs).toHaveBeenCalledTimes(1));
    const tracks = onSaveAs.mock.calls[0][1] as Array<{
      color: string;
      gmProgram: number;
    }>;
    expect(tracks[0].gmProgram).toBe(1);
    expect(new Set(tracks.map((track) => track.color)).size).toBe(2);
    expect(tracks.map((track) => track.color)).toEqual([
      "#4C9AFF",
      "#E85AAD",
    ]);
  });

  it("shows the native color picker only for a custom color", () => {
    render(
      <PresetEditor
        instruments={instruments}
        preset={{
          ...preset,
          tracks: [
            {
              ...preset.tracks[0],
              color: "#4C9AFF",
            },
          ],
        }}
        onCancel={vi.fn()}
        onSaveAs={vi.fn()}
        onOverwrite={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("カスタム色")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("トラック色"), {
      target: { value: "custom" },
    });
    expect(screen.getByLabelText("カスタム色")).toHaveValue("#4c9aff");
  });

  it("overwrites a user preset while preserving its id", async () => {
    const onOverwrite = vi.fn().mockResolvedValue(undefined);
    const userPreset = {
      ...preset,
      id: "user-preset-id",
      key: "user:user-preset-id",
      name: "User Band",
    };
    render(
      <PresetEditor
        instruments={instruments}
        preset={userPreset}
        onCancel={vi.fn()}
        onSaveAs={vi.fn()}
        onOverwrite={onOverwrite}
      />,
    );

    expect(screen.getByLabelText("プリセット名")).toHaveValue("User Band");
    fireEvent.change(screen.getAllByLabelText("トラック名")[0], {
      target: { value: "Keys" },
    });
    fireEvent.click(screen.getByRole("button", { name: "上書き保存" }));

    await waitFor(() => expect(onOverwrite).toHaveBeenCalledTimes(1));
    expect(onOverwrite.mock.calls[0][0]).toBe("user-preset-id");
    expect(onOverwrite.mock.calls[0][1]).toBe("User Band");
    expect(onOverwrite.mock.calls[0][2][0].displayName).toBe("Keys");
  });

  it("offers save as without allowing a built-in preset overwrite", () => {
    render(
      <PresetEditor
        instruments={instruments}
        preset={preset}
        onCancel={vi.fn()}
        onSaveAs={vi.fn()}
        onOverwrite={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("プリセット名")).toHaveValue("Band コピー");
    expect(screen.getByRole("button", { name: "上書き保存" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "別名保存" })).toBeEnabled();
  });
});
