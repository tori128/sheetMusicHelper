import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalApiClient } from "../api";
import { SettingsDialog } from "./SettingsDialog";

describe("SettingsDialog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists usage and deletes only confirmed selected cache entries", async () => {
    const deleteCacheEntry = vi.fn().mockResolvedValue({ deleted: true });
    const client = {
      cacheEntries: Promise.resolve([
        {
          id: "audio/analysis.wav",
          sizeBytes: 2048,
          modifiedAt: "2026-07-26T00:00:00Z",
          kind: "audio",
        },
      ]),
      deleteCacheEntry,
    } as unknown as LocalApiClient;
    vi.stubGlobal("confirm", vi.fn(() => true));

    render(<SettingsDialog client={client} onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByText("audio/analysis.wav")).toBeInTheDocument(),
    );
    expect(screen.getByText("2.0 KiB")).toBeInTheDocument();
    expect(screen.getByText(/キャッシュ 2.0 KiB/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("audio/analysis.wavを選択"));
    fireEvent.click(screen.getByText("選択項目を削除"));

    await waitFor(() =>
      expect(deleteCacheEntry).toHaveBeenCalledWith("audio/analysis.wav"),
    );
    expect(screen.getByText("キャッシュなし")).toBeInTheDocument();
  });
});
