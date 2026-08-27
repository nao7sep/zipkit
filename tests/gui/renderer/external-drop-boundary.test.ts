// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  denyUnhandledExternalDrop,
  droppedFileOperationKey,
  receiverOperationKey,
  settleReceiverResult,
} from "../../../src/gui/renderer/src/externalDropBoundary";

function drag(target: Element, types: string[], items: Array<{ kind: string }> = []): DragEvent {
  const event = new Event("drop", { cancelable: true }) as DragEvent;
  Object.defineProperties(event, {
    target: { value: target },
    dataTransfer: { value: { types, items, dropEffect: "copy" } },
  });
  return event;
}

describe("desktop drop boundary", () => {
  it("retains editable text and denies files or unowned text", () => {
    const text = drag(document.createElement("textarea"), ["text/plain"]);
    denyUnhandledExternalDrop(text);
    expect(text.defaultPrevented).toBe(false);

    const file = drag(document.createElement("textarea"), [], [{ kind: "file" }]);
    denyUnhandledExternalDrop(file);
    expect(file.defaultPrevented).toBe(true);

    const unowned = drag(document.createElement("div"), ["text/plain"]);
    denyUnhandledExternalDrop(unowned);
    expect(unowned.defaultPrevented).toBe(true);
  });

  it("settles only the result owned by a successful operation", () => {
    const firstKey = receiverOperationKey("inputs:job-1", ["/a"]);
    const otherKey = receiverOperationKey("inputs:job-1", ["/b"]);
    const current = settleReceiverResult(null, {
      operationKey: firstKey,
      entryKey: "inputs:job-1:picker",
      result: { message: "Already present", severity: "information" },
    });

    expect(settleReceiverResult(current, {
      operationKey: otherKey,
      entryKey: "inputs:job-1:picker",
      result: null,
    })).toBe(current);
    expect(settleReceiverResult(current, {
      operationKey: firstKey,
      entryKey: "inputs:job-1:picker",
      result: null,
    })).toBeNull();
  });

  it("uses native file identity before host-path resolution", () => {
    const first = new File(["a"], "sample.txt", { type: "text/plain", lastModified: 42 });
    const second = new File(["b"], "other.txt", { type: "text/plain", lastModified: 43 });

    expect(droppedFileOperationKey("jobs", [first, second]))
      .toBe(droppedFileOperationKey("jobs", [second, first]));
    expect(droppedFileOperationKey("jobs", [first]))
      .not.toBe(droppedFileOperationKey("jobs", [second]));
  });

  it("clears an entry-boundary failure on that entry's next success only", () => {
    const pickerFailure = settleReceiverResult(null, {
      operationKey: "jobs:picker",
      entryKey: "jobs:picker",
      result: { message: "Could not choose inputs", severity: "error" },
    });

    expect(settleReceiverResult(pickerFailure, {
      operationKey: receiverOperationKey("jobs", ["/tmp/sample"]),
      entryKey: "jobs:drop",
      result: null,
    })).toBe(pickerFailure);
    expect(settleReceiverResult(pickerFailure, {
      operationKey: receiverOperationKey("jobs", ["/tmp/sample"]),
      entryKey: "jobs:picker",
      result: null,
    })).toBeNull();
  });
});
