import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StemSeparationCapability } from "../types";
import { StemModelDownloadDialog } from "./StemModelDownloadDialog";

const capability: StemSeparationCapability = {
  available: false,
  modelDirectory: "D:\\EarCopyAssist\\models\\bs-roformer\\sw-fixed",
  modelName: "BS-RoFormer SW Fixed",
  modelFileName: "BS-Rofo-SW-Fixed.ckpt",
  modelSizeBytes: 699_412_152,
  modelSha256:
    "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e",
  licenseStatus: "Unknown",
  sourcePageUrl:
    "https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/tree/main",
  reason: "モデルが見つかりません",
};

afterEach(cleanup);

describe("StemModelDownloadDialog", () => {
  it("requires acknowledgement after showing the license and file identity", () => {
    render(
      <StemModelDownloadDialog
        capability={capability}
        onCancel={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    expect(screen.getByText("ライセンス: Unknown")).toBeVisible();
    expect(screen.getByText(capability.sourcePageUrl)).toBeVisible();
    expect(screen.getByText(capability.modelSha256)).toBeVisible();
    const download = screen.getByRole("button", {
      name: "警告を確認してダウンロード",
    });
    expect(download).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "ライセンスがUnknownであり、利用許諾を確認できないことを理解しました",
      }),
    );
    expect(download).toBeEnabled();
  });

  it("shows a download failure and permits a retry", async () => {
    const onDownload = vi.fn().mockRejectedValue(new Error("受信に失敗しました"));
    render(
      <StemModelDownloadDialog
        capability={capability}
        onCancel={vi.fn()}
        onDownload={onDownload}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "警告を確認してダウンロード" }),
    );

    expect(
      await screen.findByText("受信に失敗しました"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "警告を確認してダウンロード" }),
      ).toBeEnabled(),
    );
  });
});
