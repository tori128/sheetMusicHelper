import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModelDownloadProgressView } from "./ModelDownloadProgressView";

afterEach(cleanup);
describe("download progress display", () => {
  it("shows the received percentage and MiB", () => {
    render(<ModelDownloadProgressView label="採譜モデルを取得中" progress={{ phase: "downloading", completedBytes: 1048576, totalBytes: 2097152 }} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "50");
    expect(screen.getByText(/50%/)).toBeVisible();
    expect(screen.getByText("1 / 2 MiB")).toBeVisible();
  });
  it("identifies verification while its duration is unknown", () => {
    render(<ModelDownloadProgressView label="音源分離モデルをダウンロード中" progress={{ phase: "verifying", completedBytes: 0, totalBytes: 0 }} />);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
    expect(screen.getByText("SHA-256を検証中…")).toBeVisible();
  });
});
