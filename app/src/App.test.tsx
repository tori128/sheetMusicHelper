import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "./types";

vi.mock("./api", () => ({
  LocalApiClient: class {
    get instruments() {
      return Promise.resolve([]);
    }

    get presets() {
      return Promise.resolve([]);
    }

    get models() {
      return Promise.resolve([]);
    }

    get backends() {
      return Promise.resolve([]);
    }

    get stemSeparation() {
      return Promise.resolve({
        available: false,
        modelDirectory: "",
        modelName: "BS-RoFormer SW Fixed",
        modelFileName: "BS-Rofo-SW-Fixed.ckpt",
        modelSizeBytes: 699_412_152,
        modelSha256: "24e7",
        licenseStatus: "Unknown",
        sourcePageUrl: "https://huggingface.co/example/model",
        reason: "",
      });
    }
  },
}));

vi.mock("./components/NewProjectScreen", () => ({
  NewProjectScreen: () => <div>新規プロジェクト画面</div>,
}));

vi.mock("./components/EditorScreen", () => ({
  EditorScreen: () => <div>編集画面</div>,
}));

import App from "./App";
import { projectStore } from "./store/project-store";

describe("App startup terms", () => {
  const getServiceConnection = vi.fn(async () => ({
    baseUrl: "http://127.0.0.1:12345",
    token: "test-token",
  }));
  const quitApplication = vi.fn(async () => undefined);

  beforeEach(() => {
    projectStore.closeProject();
    getServiceConnection.mockClear();
    quitApplication.mockClear();
    window.desktopApi = {
      getServiceConnection,
      quitApplication,
    } as unknown as DesktopApi;
  });

  afterEach(() => {
    cleanup();
  });

  it("starts the backend only after the terms are accepted", async () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "MuScriptorモデルの利用条件" }),
    ).toBeInTheDocument();
    expect(getServiceConnection).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "上記の利用条件を確認し、同意します",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "同意して起動" }));

    await waitFor(() => expect(getServiceConnection).toHaveBeenCalledOnce());
    expect(await screen.findByText("新規プロジェクト画面")).toBeInTheDocument();
  });

  it("quits without starting the backend", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "終了" }));

    expect(quitApplication).toHaveBeenCalledOnce();
    expect(getServiceConnection).not.toHaveBeenCalled();
  });
});
