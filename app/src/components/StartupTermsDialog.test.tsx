import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupTermsDialog } from "./StartupTermsDialog";

afterEach(cleanup);

describe("StartupTermsDialog", () => {
  it("requires explicit confirmation before starting", () => {
    const onAccept = vi.fn();
    render(<StartupTermsDialog onAccept={onAccept} onExit={vi.fn()} />);

    const accept = screen.getByRole("button", { name: "同意して起動" });
    expect(accept).toBeDisabled();
    expect(screen.getByText(/CC BY-NC 4\.0/)).toBeInTheDocument();
    expect(screen.getByText(/非商用目的に限って使用/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "上記の利用条件を確認し、同意します",
      }),
    );
    expect(accept).toBeEnabled();
    fireEvent.click(accept);

    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("exits without accepting the terms", () => {
    const onExit = vi.fn();
    render(<StartupTermsDialog onAccept={vi.fn()} onExit={onExit} />);

    fireEvent.click(screen.getByRole("button", { name: "終了" }));

    expect(onExit).toHaveBeenCalledOnce();
  });
});
