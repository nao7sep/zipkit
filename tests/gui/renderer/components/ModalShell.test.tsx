// @vitest-environment jsdom
/**
 * DOM-behavior tests for the shared modal shell: initial focus, the Tab focus
 * trap, background scroll-lock (and its restore), and the Escape / backdrop close
 * paths. These are the mechanics every dialog inherits, so they are pinned once.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModalShell } from "../../../../src/gui/renderer/src/components/ModalShell";

afterEach(cleanup);

function renderShell(onClose = vi.fn()) {
  render(
    <ModalShell
      title="Title"
      onClose={onClose}
      footer={
        <>
          <button>First</button>
          <button>Second</button>
        </>
      }
    >
      <p>Body</p>
    </ModalShell>,
  );
  return onClose;
}

describe("ModalShell", () => {
  it("locks background scroll while open and restores it on unmount", () => {
    const { unmount } = render(
      <ModalShell title="T" onClose={() => {}} footer={<button>Close</button>}>
        <p>b</p>
      </ModalShell>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("focuses the first footer control on open (the safe default)", () => {
    renderShell();
    expect(document.activeElement).toBe(screen.getByText("First"));
  });

  it("traps Tab at both boundaries", () => {
    renderShell();
    const first = screen.getByText("First");
    const last = screen.getByText("Second");
    const dialog = screen.getByRole("dialog");

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first); // forward wrap

    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last); // backward wrap
  });

  it("Escape routes to onClose", () => {
    const onClose = renderShell();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("backdrop click routes to onClose", () => {
    const onClose = vi.fn();
    render(
      <ModalShell title="T" onClose={onClose} footer={<button>Close</button>}>
        <p>b</p>
      </ModalShell>,
    );
    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
