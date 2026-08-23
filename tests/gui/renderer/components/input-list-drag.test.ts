import { describe, expect, it } from "vitest";

import { inspectInputDragOffer } from "../../../../src/gui/renderer/src/components/InputList";

describe("InputList drag offers", () => {
  it("keeps an uninspectable native Files offer delivery-only", () => {
    expect(
      inspectInputDragOffer({
        types: ["Files"],
        items: [] as unknown as DataTransferItemList,
        files: [] as unknown as FileList,
      }),
    ).toBe("delivery-only");
  });

  it("accepts an inspectable file and rejects text", () => {
    const file = new File(["data"], "input.txt");
    expect(
      inspectInputDragOffer({
        types: ["Files"],
        items: [{ kind: "file", getAsFile: () => file }] as unknown as DataTransferItemList,
        files: [file] as unknown as FileList,
      }),
    ).toBe("accepted");
    expect(
      inspectInputDragOffer({
        types: ["text/plain"],
        items: [{ kind: "string" }] as unknown as DataTransferItemList,
        files: [] as unknown as FileList,
      }),
    ).toBe("rejected");
  });
});
