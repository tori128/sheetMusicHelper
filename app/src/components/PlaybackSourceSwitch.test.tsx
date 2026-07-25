import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlaybackSourceSwitch } from "./PlaybackSourceSwitch";

afterEach(cleanup);

it("shows the active playback source and exposes both choices as buttons", () => {
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
  expect(screen.getByRole("group", { name: "再生音を切り替え" })).toBeVisible();
  expect(original).toHaveAttribute("aria-pressed", "true");
  expect(transcription).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(transcription);
  expect(onChange).toHaveBeenCalledWith("transcription");

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
});
