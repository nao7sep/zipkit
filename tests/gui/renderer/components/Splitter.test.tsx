// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Splitter } from "../../../../src/gui/renderer/src/components/Splitter";

afterEach(cleanup);

describe("Splitter keyboard resizing", () => {
  it("exposes its range and routes arrows/Home/End through the resize authority", () => {
    const onKeyboardDelta = vi.fn();
    render(
      <Splitter
        label="Resize Jobs pane"
        value={300}
        min={200}
        max={480}
        onDragStart={vi.fn()}
        onDragDelta={vi.fn()}
        onDragEnd={vi.fn()}
        onDragCancel={vi.fn()}
        onKeyboardDelta={onKeyboardDelta}
      />,
    );
    const splitter = screen.getByRole("separator");
    expect(splitter.tabIndex).toBe(0);
    expect(splitter.getAttribute("aria-valuenow")).toBe("300");
    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    fireEvent.keyDown(splitter, { key: "ArrowLeft" });
    fireEvent.keyDown(splitter, { key: "Home" });
    fireEvent.keyDown(splitter, { key: "End" });
    expect(onKeyboardDelta.mock.calls.map(([delta]) => delta)).toEqual([10, -10, -100, 180]);
  });

  it("maps Home/End to physical bounds for a reverse-width pane", () => {
    const onKeyboardDelta = vi.fn();
    render(
      <Splitter label="Resize Progress pane" value={320} min={240} max={600} direction={-1}
        onDragStart={vi.fn()} onDragDelta={vi.fn()} onDragEnd={vi.fn()}
        onDragCancel={vi.fn()}
        onKeyboardDelta={onKeyboardDelta} />,
    );
    const splitter = screen.getByRole("separator");
    fireEvent.keyDown(splitter, { key: "Home" });
    fireEvent.keyDown(splitter, { key: "End" });
    expect(onKeyboardDelta.mock.calls.map(([delta]) => delta)).toEqual([-280, 80]);
  });

  it("restores a drag through the cancellation callback on window blur", () => {
    const onDragDelta = vi.fn();
    const onDragEnd = vi.fn();
    const onDragCancel = vi.fn();
    render(
      <Splitter
        label="Resize Jobs pane"
        value={300}
        min={200}
        max={480}
        onDragStart={vi.fn()}
        onDragDelta={onDragDelta}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        onKeyboardDelta={vi.fn()}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("separator"), { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 135 });
    expect(onDragDelta).toHaveBeenCalledWith(35);
    expect(document.body.style.cursor).toBe("col-resize");

    fireEvent.blur(window);
    expect(onDragCancel).toHaveBeenCalledOnce();
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });
});
