// @vitest-environment jsdom
/**
 * DOM-behavior tests for the confirm host: a confirm settles true/false on its
 * buttons, and concurrent requests queue — only one dialog shows at a time and
 * each promise settles in turn (none is dropped).
 */

import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ConfirmOptions, DialogHost, useConfirm } from "../../../../src/gui/renderer/src/components/DialogHost";

afterEach(cleanup);

function Harness() {
  const confirm = useConfirm();
  const [log, setLog] = useState<string[]>([]);
  const ask = (name: string, opts: ConfirmOptions) => async () => {
    const result = await confirm(opts);
    setLog((l) => [...l, `${name}:${result}`]);
  };
  return (
    <div>
      <button onClick={ask("a", { title: "First?", message: "m1", confirmLabel: "Yes", danger: true })}>askA</button>
      <button onClick={ask("b", { title: "Second?", message: "m2", confirmLabel: "Go" })}>askB</button>
      <div data-testid="log">{log.join(",")}</div>
    </div>
  );
}

const log = () => screen.getByTestId("log").textContent;

describe("DialogHost", () => {
  it("settles true on the confirm button", async () => {
    render(
      <DialogHost>
        <Harness />
      </DialogHost>,
    );
    fireEvent.click(screen.getByText("askA"));
    fireEvent.click(await screen.findByText("Yes"));
    await waitFor(() => expect(log()).toBe("a:true"));
  });

  it("settles false on Cancel", async () => {
    render(
      <DialogHost>
        <Harness />
      </DialogHost>,
    );
    fireEvent.click(screen.getByText("askA"));
    fireEvent.click(await screen.findByText("Cancel"));
    await waitFor(() => expect(log()).toBe("a:false"));
  });

  it("queues concurrent requests and settles each in turn", async () => {
    render(
      <DialogHost>
        <Harness />
      </DialogHost>,
    );
    fireEvent.click(screen.getByText("askA"));
    fireEvent.click(screen.getByText("askB"));

    // Only the first dialog is shown.
    expect(screen.getByText("First?")).toBeTruthy();
    expect(screen.queryByText("Second?")).toBeNull();

    fireEvent.click(await screen.findByText("Yes")); // settle A (true)
    await screen.findByText("Second?"); // B now surfaces
    fireEvent.click(screen.getByText("Cancel")); // settle B (false)

    await waitFor(() => expect(log()).toBe("a:true,b:false"));
  });
});
