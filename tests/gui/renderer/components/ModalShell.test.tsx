// @vitest-environment jsdom
/**
 * Behavior tests for the shared modal shell. The shell is now a thin binding over
 * Radix's Dialog, so these pin the contract and the shell's own additions — an
 * accessible dialog named by its title, footer-first safe-default focus, the
 * close path through `onClose`, and the IME-Escape guard. They deliberately do
 * NOT re-test Radix's internal focus-trap and scroll-lock mechanics, which the
 * library owns and tests upstream and which jsdom cannot exercise faithfully.
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
  it("renders an accessible dialog named by its title", () => {
    renderShell();
    expect(screen.getByRole("dialog", { name: "Title" })).toBeTruthy();
  });

  it("focuses the first footer control on open (the safe default)", () => {
    renderShell();
    expect(document.activeElement).toBe(screen.getByText("First"));
  });

  it("Escape routes to onClose", () => {
    const onClose = renderShell();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape during IME composition does not close (the candidate is dismissed, not the dialog)", () => {
    const onClose = renderShell();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a footer Close button routes to onClose", () => {
    const onClose = vi.fn();
    render(
      <ModalShell title="T" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
        <p>b</p>
      </ModalShell>,
    );
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
