import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalApiClient } from "../api";
import { SettingsDialog } from "./SettingsDialog";
import { LanguageProvider } from "../i18n";

describe("SettingsDialog", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("persists signed playback offsets selected from the slider", async () => {
    const client = {
      cacheEntries: Promise.resolve([]),
    } as unknown as LocalApiClient;
    const onSourcePlaybackDelayChange = vi.fn();

    render(
      <SettingsDialog
        client={client}
        onClose={vi.fn()}
        onSourcePlaybackDelayChange={onSourcePlaybackDelayChange}
      />,
    );

    const input = screen.getByLabelText("再生位置オフセット");
    expect(input).toHaveAttribute("type", "range");
    expect(input).toHaveAttribute("min", "-200");
    expect(input).toHaveAttribute("max", "200");
    expect(input).toHaveValue("15");
    fireEvent.change(input, { target: { value: "-200" } });
    expect(input).toHaveValue("-200");
    expect(window.localStorage.getItem("earcopy-source-playback-delay-ms")).toBe(
      "-200",
    );
    expect(onSourcePlaybackDelayChange).toHaveBeenCalledWith(-200);
    expect(screen.getByText("-200 ms")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "200" } });
    expect(input).toHaveValue("200");
    expect(onSourcePlaybackDelayChange).toHaveBeenLastCalledWith(200);
    expect(screen.getByText("+200 ms")).toBeInTheDocument();
    expect(
      screen.getByText("正の値は原音、負の値は採譜結果を遅らせます。"),
    ).toBeInTheDocument();
  });

  it("persists the selected audio output device", async () => {
    const enumerateDevices = vi.fn().mockResolvedValue([
      {
        deviceId: "default",
        kind: "audiooutput",
        label: "既定のスピーカー",
      },
      {
        deviceId: "usb-headset",
        kind: "audiooutput",
        label: "USBヘッドセット",
      },
    ]);
    vi.stubGlobal("navigator", {
      mediaDevices: { enumerateDevices },
    });
    const onAudioOutputDeviceChange = vi.fn().mockResolvedValue(undefined);
    const client = {
      cacheEntries: Promise.resolve([]),
    } as unknown as LocalApiClient;

    render(
      <SettingsDialog
        client={client}
        onAudioOutputDeviceChange={onAudioOutputDeviceChange}
        onClose={vi.fn()}
      />,
    );

    const select = await screen.findByLabelText("オーディオ出力デバイス");
    await screen.findByRole("option", { name: "USBヘッドセット" });
    fireEvent.change(select, { target: { value: "usb-headset" } });

    await waitFor(() =>
      expect(onAudioOutputDeviceChange).toHaveBeenCalledWith("usb-headset"),
    );
    expect(window.localStorage.getItem("earcopy-audio-output-device-id")).toBe(
      "usb-headset",
    );
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
        {
          id: "transcriptions/result.json.gz",
          sizeBytes: 1024,
          modifiedAt: "2026-07-26T00:01:00Z",
          kind: "transcriptions",
        },
      ]),
      deleteCacheEntry,
    } as unknown as LocalApiClient;
    vi.stubGlobal("confirm", vi.fn(() => true));

    render(<SettingsDialog client={client} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "キャッシュ" }));
    await waitFor(() =>
      expect(screen.getByText("audio/analysis.wav")).toBeInTheDocument(),
    );
    expect(screen.getByText("2.0 KiB")).toBeInTheDocument();
    expect(screen.getByText("解析用音声")).toBeInTheDocument();
    expect(screen.getByText("採譜結果")).toBeInTheDocument();
    expect(screen.getByText("最終使用")).toBeInTheDocument();
    expect(screen.getByText(/キャッシュ 3.0 KiB/)).toBeInTheDocument();
    expect(
      screen.getByText(/種類ごとに最終使用10件を保持/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("audio/analysis.wavを選択"));
    fireEvent.click(screen.getByText("選択項目を削除"));

    await waitFor(() =>
      expect(deleteCacheEntry).toHaveBeenCalledWith("audio/analysis.wav"),
    );
    expect(
      screen.getByText("transcriptions/result.json.gz"),
    ).toBeInTheDocument();
  });

  it("loads cache entries only after the cache tab is selected", async () => {
    const cacheEntries = vi.fn(() => Promise.resolve([]));
    const client = {} as LocalApiClient;
    Object.defineProperty(client, "cacheEntries", {
      get: cacheEntries,
    });

    render(<SettingsDialog client={client} onClose={vi.fn()} />);

    expect(cacheEntries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "キャッシュ" }));
    await waitFor(() => expect(cacheEntries).toHaveBeenCalledOnce());
  });

  it("changes and persists the display language", () => {
    const client = {
      cacheEntries: Promise.resolve([]),
    } as unknown as LocalApiClient;

    render(
      <LanguageProvider>
        <SettingsDialog client={client} onClose={vi.fn()} />
      </LanguageProvider>,
    );
    fireEvent.change(screen.getByLabelText("Language"), {
      target: { value: "en" },
    });

    expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Playback" })).toBeVisible();
    expect(window.localStorage.getItem("earcopy-display-language")).toBe("en");
  });
});
