// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { InputList } from "../../../../src/gui/renderer/src/components/InputList";
import { settleReceiverResult } from "../../../../src/gui/renderer/src/externalDropBoundary";
import type { Job } from "../../../../src/gui/shared/api";
import { DEFAULT_OPTIONS } from "../../../../src/gui/shared/spec";

afterEach(cleanup);

const job: Job = {
  id: "job-1",
  inputs: ["/tmp/existing.txt"],
  entries: [{ path: "/tmp/existing.txt", kind: "file" }],
  options: DEFAULT_OPTIONS,
  intent: "save",
  state: "ready",
};

function transfer(types: string[], files: File[] = []) {
  return {
    types,
    items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
    files,
    dropEffect: "none",
  };
}

function renderInputs(over: Partial<Parameters<typeof InputList>[0]> = {}) {
  const onResult = vi.fn();
  return render(
    <InputList
      job={job}
      editable
      onAdd={async () => null}
      onRemove={() => {}}
      onDropFiles={async () => ({ operationKey: "noop", entryKey: "noop", result: null })}
      result={null}
      onResult={onResult}
      {...over}
    />,
  );
}

describe("InputList external-drop receiver", () => {
  it("highlights only Inputs and reports the committed operation result", async () => {
    const file = new File(["x"], "new.txt");
    const onDropFiles = vi.fn(async () => ({
      operationKey: "inputs:job-1:new.txt",
      entryKey: "inputs:job-1:drop",
      result: {
        message: "That input is already in this job.",
        severity: "information" as const,
      },
    }));
    let result = null as Parameters<typeof InputList>[0]["result"];
    const onResult = vi.fn((next) => { result = settleReceiverResult(result, next); });
    const view = renderInputs({ onDropFiles, result, onResult });
    const { container } = view;
    const receiver = container.querySelector<HTMLElement>('[data-drop-receiver="inputs"]')!;
    const dataTransfer = transfer(["Files"], [file]);

    fireEvent.dragOver(receiver, { dataTransfer });
    expect(receiver.style.boxShadow).toContain("var(--accent)");
    fireEvent.dragLeave(receiver, { dataTransfer });
    expect(receiver.style.boxShadow).toBe("");
    fireEvent.dragOver(receiver, { dataTransfer });

    fireEvent.drop(receiver, { dataTransfer });
    await waitFor(() => expect(onDropFiles).toHaveBeenCalledWith([file]));
    view.rerender(
      <InputList
        job={job}
        editable
        onAdd={async () => null}
        onRemove={() => {}}
        onDropFiles={onDropFiles}
        result={result}
        onResult={onResult}
      />,
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("already in this job");
    expect(status.classList.contains("receiver-result")).toBe(true);
    expect(status.classList.contains("receiver-result--information")).toBe(true);
    expect(receiver.style.boxShadow).toBe("");
  });

  it("explains a committed unsupported drop", async () => {
    let result = null as Parameters<typeof InputList>[0]["result"];
    const onResult = vi.fn((next) => { result = settleReceiverResult(result, next); });
    const view = renderInputs({ result, onResult });
    const { container } = view;
    const receiver = container.querySelector<HTMLElement>('[data-drop-receiver="inputs"]')!;
    fireEvent.drop(receiver, { dataTransfer: transfer(["text/plain"]) });
    view.rerender(
      <InputList
        job={job}
        editable
        onAdd={async () => null}
        onRemove={() => {}}
        onDropFiles={async () => ({ operationKey: "noop", entryKey: "noop", result: null })}
        result={result}
        onResult={onResult}
      />,
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Drop files or folders");
    expect(status.classList.contains("receiver-result--warning")).toBe(true);
  });

  it("keeps unrelated feedback but clears it when the same operation succeeds", async () => {
    const file = new File(["x"], "new.txt");
    const onDropFiles = vi.fn()
      .mockResolvedValueOnce({
        operationKey: "inputs:job-1:new.txt",
        entryKey: "inputs:job-1:drop",
        result: { message: "That input is already in this job.", severity: "information" },
      })
      .mockResolvedValueOnce({
        operationKey: "inputs:job-1:other.txt",
        entryKey: "inputs:job-1:drop",
        result: null,
      })
      .mockResolvedValueOnce({
        operationKey: "inputs:job-1:new.txt",
        entryKey: "inputs:job-1:drop",
        result: null,
      });
    let result = null as Parameters<typeof InputList>[0]["result"];
    const onResult = vi.fn((next) => { result = settleReceiverResult(result, next); });
    const view = renderInputs({ onDropFiles, result, onResult });
    const { container } = view;
    const receiver = container.querySelector<HTMLElement>('[data-drop-receiver="inputs"]')!;

    fireEvent.drop(receiver, { dataTransfer: transfer(["Files"], [file]) });
    await waitFor(() => expect(onDropFiles).toHaveBeenCalledTimes(1));
    view.rerender(
      <InputList
        job={job}
        editable
        onAdd={async () => null}
        onRemove={() => {}}
        onDropFiles={onDropFiles}
        result={result}
        onResult={onResult}
      />,
    );
    expect((await screen.findByRole("status")).textContent).toContain("already in this job");

    fireEvent.drop(receiver, { dataTransfer: transfer(["Files"], [file]) });
    await waitFor(() => expect(onDropFiles).toHaveBeenCalledTimes(2));
    view.rerender(
      <InputList
        job={job}
        editable
        onAdd={async () => null}
        onRemove={() => {}}
        onDropFiles={onDropFiles}
        result={result}
        onResult={onResult}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("already in this job");

    fireEvent.drop(receiver, { dataTransfer: transfer(["Files"], [file]) });
    await waitFor(() => expect(onDropFiles).toHaveBeenCalledTimes(3));
    view.rerender(
      <InputList
        job={job}
        editable
        onAdd={async () => null}
        onRemove={() => {}}
        onDropFiles={onDropFiles}
        result={result}
        onResult={onResult}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not present acceptance while the job is not editable", () => {
    const file = new File(["x"], "new.txt");
    const { container } = renderInputs({ editable: false });
    const receiver = container.querySelector<HTMLElement>('[data-drop-receiver="inputs"]')!;
    const dataTransfer = transfer(["Files"], [file]);
    fireEvent.dragOver(receiver, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("none");
    expect(receiver.style.boxShadow).toBe("");
  });

  it("identifies a picker-boundary failure with the picker entry", async () => {
    const onResult = vi.fn();
    Object.defineProperty(window, "zipkit", {
      configurable: true,
      value: { reportError: vi.fn() },
    });
    renderInputs({
      onAdd: async () => { throw new Error("picker unavailable"); },
      onResult,
    });

    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({
      operationKey: "inputs:job-1:picker",
      entryKey: "inputs:job-1:picker",
      result: {
        message: "Inputs could not be added. Check that they are still available, then try again.",
        severity: "error",
      },
    }));
  });
});
