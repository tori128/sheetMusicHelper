import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, ModelProfile } from "../types";
import { AboutDialog } from "./AboutDialog";

const model: ModelProfile = {
  id: "model-1",
  profileName: "MuScriptor small",
  modelPath: "D:\\models\\model.safetensors",
  fileName: "model.safetensors",
  sha256: "a".repeat(64),
  variant: "small",
  dtype: "float32",
  defaultBackend: "CPU",
};

describe("AboutDialog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows versions, registered model hashes and bundled licenses", async () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAboutInfo: vi.fn().mockResolvedValue({
          appVersion: "0.1.0",
          engineVersion: "0.2.2",
          notices: [
            { name: "THIRD_PARTY_NOTICES.txt", text: "notices" },
            { name: "MuScriptor/LICENSE", text: "MIT License" },
            {
              name: "MuScriptor/README.md",
              text: "Copyright (c) 2026 Kyutai x Mirelo",
            },
          ],
        }),
      } as unknown as DesktopApi,
    });

    render(<AboutDialog models={[model]} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("0.1.0")).toBeInTheDocument();
      expect(screen.getByText("0.2.2")).toBeInTheDocument();
    });
    expect(screen.getByText("MuScriptor small")).toBeInTheDocument();
    expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
    expect(screen.getByText("CC BY-NC 4.0")).toBeInTheDocument();

    fireEvent.click(screen.getByText("MuScriptor/LICENSE"));
    expect(screen.getByText("MIT License")).toBeInTheDocument();
    fireEvent.click(screen.getByText("MuScriptor/README.md"));
    expect(
      screen.getByText("Copyright (c) 2026 Kyutai x Mirelo"),
    ).toBeInTheDocument();
  });
});
