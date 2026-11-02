import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlaybackSourceSwitch } from "./PlaybackSourceSwitch";

afterEach(cleanup);

it("shows the active playback source and exposes all playback modes", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <PlaybackSourceSwitch
      value="original"
      transcriptionDisabled={false}
      onChange={onChange}
    />,
  );

  const original = screen.getByRole("button", { name: "原音" });
  const transcription = screen.getByRole("button", { name: "採譜結果" });
  const comparison = screen.getByRole("button", { name: "左右比較" });
  expect(screen.getByRole("group", { name: "再生音を切り替え" })).toBeVisible();
  expect(original).toHaveAttribute("aria-pressed", "true");
  expect(transcription).toHaveAttribute("aria-pressed", "false");
  expect(comparison).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(transcription);
  expect(onChange).toHaveBeenCalledWith("transcription");
  fireEvent.click(comparison);
  expect(onChange).toHaveBeenCalledWith("comparison");

  rerender(
    <PlaybackSourceSwitch
      value="transcription"
      transcriptionDisabled={false}
      onChange={onChange}
    />,
  );
  expect(original).toHaveAttribute("aria-pressed", "false");
  expect(transcription).toHaveAttribute("aria-pressed", "true");
});

it("disables the transcription choice while the SoundFont is unavailable", () => {
  render(
    <PlaybackSourceSwitch
      value="original"
      transcriptionDisabled
      onChange={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: "採譜結果" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "左右比較" })).toBeDisabled();
});

it("disables source playback while keeping transcription available", () => {
  render(
    <PlaybackSourceSwitch
      value="transcription"
      sourceDisabled
      transcriptionDisabled={false}
      onChange={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: "原音" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "採譜結果" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "左右比較" })).toBeDisabled();
});
