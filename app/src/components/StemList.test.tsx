import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectStem } from "../types";
import { StemList } from "./StemList";

function stem(
  type: ProjectStem["type"],
  mute = false,
  solo = false,
): ProjectStem {
  return {
    type,
    cachePath: `${type}.wav`,
    sha256: "a".repeat(64),
    sampleRate: 44100,
    channels: 2,
    mute,
    solo,
  };
}

afterEach(cleanup);

it("orders separated components and dispatches mute and solo operations", () => {
  const onMute = vi.fn();
  const onSolo = vi.fn();
  render(
    <StemList
      stems={[
        stem("guitar", false, true),
        stem("piano", true),
        stem("drums"),
        stem("other"),
      ]}
      onMute={onMute}
      onSolo={onSolo}
    />,
  );

  const region = screen.getByRole("region", { name: "分離音源一覧" });
  const muteButtons = within(region).getAllByRole("button", {
    name: /分離音源をミュート$/,
  });
  expect(muteButtons.map((button) => button.getAttribute("aria-label")))
    .toEqual([
      "Drums分離音源をミュート",
      "Piano分離音源をミュート",
      "Guitar分離音源をミュート",
      "Other分離音源をミュート",
    ]);
  expect(screen.getByRole("button", { name: "Piano分離音源をミュート" }))
    .toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Guitar分離音源をソロ" }))
    .toHaveAttribute("aria-pressed", "true");

  fireEvent.click(
    screen.getByRole("button", { name: "Guitar分離音源をミュート" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Guitar分離音源をソロ" }),
  );
  expect(onMute).toHaveBeenCalledWith("guitar");
  expect(onSolo).toHaveBeenCalledWith("guitar");
});

it("disables every separated-component control together", () => {
  render(
    <StemList
      stems={[stem("vocals"), stem("other")]}
      controlsDisabled
      onMute={vi.fn()}
      onSolo={vi.fn()}
    />,
  );

  expect(screen.getAllByRole("button")).toHaveLength(4);
  for (const button of screen.getAllByRole("button")) {
    expect(button).toBeDisabled();
  }
});

it("allows Mute only for Solo components while Solo is active", () => {
  render(
    <StemList
      stems={[stem("guitar", false, true), stem("piano", true)]}
      onMute={vi.fn()}
      onSolo={vi.fn()}
    />,
  );

  expect(
    screen.getByRole("button", { name: "Guitar分離音源をミュート" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Piano分離音源をミュート" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Piano分離音源をソロ" }),
  ).toBeEnabled();
});
