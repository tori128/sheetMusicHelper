import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BpmInput } from "./BpmInput";

describe("BpmInput", () => {
  afterEach(cleanup);

  it("allows replacing the complete value before committing it", () => {
    const onCommit = vi.fn();
    render(
      <label>
        BPM
        <BpmInput value={120} onCommit={onCommit} />
      </label>,
    );
    const input = screen.getByLabelText("BPM");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "9" } });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(90);
    expect(input).toHaveValue(90);
  });

  it("restores the current value when an invalid edit loses focus", () => {
    const onCommit = vi.fn();
    render(
      <label>
        BPM
        <BpmInput value={120} onCommit={onCommit} />
      </label>,
    );
    const input = screen.getByLabelText("BPM");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.blur(input);

    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue(120);
  });

  it("cannot be changed while editing is disabled", () => {
    const onCommit = vi.fn();
    render(
      <label>
        BPM
        <BpmInput value={120} disabled onCommit={onCommit} />
      </label>,
    );

    const input = screen.getByLabelText("BPM");
    expect(input).toBeDisabled();
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
