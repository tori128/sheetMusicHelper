import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrackList } from "./TrackList";

describe("TrackList", () => {
  it("renders track colors and dispatches mute/solo operations", () => {
    const onMute = vi.fn();
    const onSolo = vi.fn();
    const onPlaybackOctaveShift = vi.fn();
    const onPlaybackVolume = vi.fn();
    render(
      <TrackList
        tracks={[
          {
            id: "track-1",
            displayName: "Piano",
            instrumentId: "acoustic_piano",
            kind: "pitched",
            color: "#4C9AFF",
            order: 1,
            midiChannel: 1,
            gmProgram: 0,
            playbackOctaveShift: 0,
            playbackVolume: 75,
            mute: false,
            solo: true,
          },
          {
            id: "track-2",
            displayName: "Vocal",
            instrumentId: "voice",
            kind: "pitched",
            color: "#36B37E",
            order: 2,
            midiChannel: 2,
            gmProgram: 71,
            playbackOctaveShift: 0,
            playbackVolume: 100,
            mute: false,
            solo: false,
          },
        ]}
        onMute={onMute}
        onSolo={onSolo}
        onPlaybackOctaveShift={onPlaybackOctaveShift}
        onPlaybackVolume={onPlaybackVolume}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Pianoをミュート" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Pianoをソロ" }));

    expect(onMute).toHaveBeenCalledWith("track-1");
    expect(onSolo).toHaveBeenCalledWith("track-1");
    expect(
      screen.getByRole("button", { name: "Pianoをソロ" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Vocal")).toHaveAttribute(
      "title",
      "Vocal\n再生音色: クラリネット",
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "Vocalの再生オクターブ" }),
      { target: { value: "1" } },
    );
    expect(onPlaybackOctaveShift).toHaveBeenCalledWith("track-2", 1);
    fireEvent.change(
      screen.getByRole("slider", { name: "Pianoの再生音量" }),
      { target: { value: "42" } },
    );
    expect(onPlaybackVolume).toHaveBeenCalledWith("track-1", 42);
  });

  it("allows only the selected Solo track to use Mute when enabled", () => {
    render(
      <TrackList
        tracks={[
          {
            id: "solo",
            displayName: "Solo",
            instrumentId: "acoustic_piano",
            kind: "pitched",
            color: "#4C9AFF",
            order: 1,
            midiChannel: 1,
            gmProgram: 0,
            playbackOctaveShift: 0,
            playbackVolume: 100,
            mute: false,
            solo: true,
          },
          {
            id: "muted",
            displayName: "Muted",
            instrumentId: "electric_bass",
            kind: "pitched",
            color: "#7A5AF8",
            order: 2,
            midiChannel: 2,
            gmProgram: 33,
            playbackOctaveShift: 0,
            playbackVolume: 100,
            mute: true,
            solo: false,
          },
        ]}
        onMute={vi.fn()}
        onSolo={vi.fn()}
        onPlaybackOctaveShift={vi.fn()}
        onPlaybackVolume={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Soloをミュート" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Mutedをミュート" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mutedをソロ" })).toBeEnabled();
  });
});
