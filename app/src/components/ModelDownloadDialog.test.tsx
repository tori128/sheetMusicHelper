import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalApiClient } from "../api";
import type { ModelDownloadOption } from "../types";
import { ModelDownloadDialog } from "./ModelDownloadDialog";

const options: ModelDownloadOption[] = [
  { variant: "medium", downloadSizeBytes: 729275588, requiredSpaceBytes: 1957420186, installed: false },
  { variant: "small", downloadSizeBytes: 243111553, requiredSpaceBytes: 655000277, installed: false },
  { variant: "large", downloadSizeBytes: 3224703894, requiredSpaceBytes: 11915050049, installed: false },
];

afterEach(cleanup);

describe("ModelDownloadDialog", () => {
  it("selects medium and shows its download and disk requirements before downloading", async () => {
    const onDownload = vi.fn().mockResolvedValue(undefined);
    render(<ModelDownloadDialog client={{ get modelDownloads() { return Promise.resolve(options); } } as LocalApiClient}
      onCancel={vi.fn()} onDownload={onDownload} />);
    await waitFor(() => expect(screen.getByLabelText("取得するモデル")).toBeEnabled());
    expect(screen.getByLabelText("取得するモデル")).toHaveValue("medium");
    expect(screen.getByText("0.73 GB")).toBeVisible();
    expect(onDownload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取得して使用" }));
    await waitFor(() => expect(onDownload).toHaveBeenCalledWith("medium", expect.any(Function)));
  });

  it("allows additional variants and retries a failed download", async () => {
    const onDownload = vi.fn().mockRejectedValueOnce(new Error("接続できません")).mockResolvedValue(undefined);
    render(<ModelDownloadDialog client={{ get modelDownloads() { return Promise.resolve(options); } } as LocalApiClient}
      onCancel={vi.fn()} onDownload={onDownload} />);
    await waitFor(() => expect(screen.getByLabelText("取得するモデル")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("取得するモデル"), { target: { value: "large" } });
    expect(screen.getByText("3.22 GB")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "取得して使用" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("接続できません");
    fireEvent.click(screen.getByRole("button", { name: "取得して使用" }));
    await waitFor(() => expect(onDownload).toHaveBeenCalledTimes(2));
    expect(onDownload).toHaveBeenLastCalledWith("large", expect.any(Function));
  });

  it("shows installed models and permits reloading the catalog after a failure", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("情報を取得できません"))
      .mockResolvedValue(options.map((option) => ({ ...option, installed: option.variant === "medium" })));
    const onDownload = vi.fn();
    render(<ModelDownloadDialog client={{ get modelDownloads() { return load(); } } as LocalApiClient}
      onCancel={vi.fn()} onDownload={onDownload} />);
    fireEvent.click(await screen.findByRole("button", { name: "再読み込み" }));
    expect(await screen.findByRole("button", { name: "取得済み" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("取得するモデル"), { target: { value: "small" } });
    expect(screen.getByRole("button", { name: "取得して使用" })).toBeEnabled();
    expect(onDownload).not.toHaveBeenCalled();
  });
});
