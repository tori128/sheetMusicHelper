import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      setUnsavedChanges: vi.fn(),
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

  it("publishes project changes and saves to the desktop close confirmation", () => {
    render(<App />);
    const publish = window.desktopApi.setUnsavedChanges;
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
      hasUnsavedChanges: false,
    }));
    act(() => projectStore.createProject({
      name: "Close confirmation",
      audio: {
        absolutePath: "D:\\audio.wav",
        sha256: "a".repeat(64),
        durationSec: 10,
        sampleRate: 48000,
        channels: 2,
        codecName: "pcm",
      },
      bpm: 120,
      numerator: 4,
      denominator: 4,
      instrumentSelectionMode: "automatic",
      instruments: [],
    }));
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
      hasUnsavedChanges: true,
    }));
    act(() => projectStore.markSaved(projectStore.getSnapshot().project!));
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
      hasUnsavedChanges: false,
    }));
    act(() => projectStore.setBpm(125));
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
      hasUnsavedChanges: true,
    }));
    act(() => projectStore.closeProject());
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
      hasUnsavedChanges: false,
    }));
  });
});
