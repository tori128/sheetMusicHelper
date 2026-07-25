import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrackList } from "./TrackList";

describe("TrackList", () => {
  it("renders track colors and dispatches mute/solo operations", () => {
    const onMute = vi.fn();
    const onSolo = vi.fn();
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
            mute: false,
            solo: true,
          },
        ]}
        onMute={onMute}
        onSolo={onSolo}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "M" }));
    fireEvent.click(screen.getByRole("button", { name: "S" }));

    expect(onMute).toHaveBeenCalledWith("track-1");
    expect(onSolo).toHaveBeenCalledWith("track-1");
    expect(screen.getByRole("button", { name: "S" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

