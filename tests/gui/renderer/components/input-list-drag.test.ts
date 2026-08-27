import { describe, expect, it } from "vitest";

import {
  inspectExternalFileOffer,
  reportableError,
  resolveDroppedFiles,
  summarizeDroppedFiles,
} from "../../../../src/gui/renderer/src/externalDropBoundary";

describe("InputList drag offers", () => {
  it("keeps an uninspectable native Files offer delivery-only", () => {
    expect(
      inspectExternalFileOffer({
        types: ["Files"],
        items: [] as unknown as DataTransferItemList,
      }),
    ).toBe("delivery-only");
  });

  it("keeps an inspectable browser File delivery-only until its local path resolves", () => {
    const file = new File(["x"], "input.txt");
    expect(
      inspectExternalFileOffer({
        types: ["Files"],
        items: [{ kind: "file", getAsFile: () => file }] as unknown as DataTransferItemList,
      }),
    ).toBe("delivery-only");
  });

  it("rejects text", () => {
    expect(
      inspectExternalFileOffer({
        types: ["text/plain"],
        items: [{ kind: "string" }] as unknown as DataTransferItemList,
      }),
    ).toBe("rejected");
  });

  it("resolves unique local paths and ignores inaccessible files", () => {
    const first = new File(["a"], "first.txt");
    const duplicate = new File(["b"], "duplicate.txt");
    const inaccessible = new File(["c"], "inaccessible.txt");

    const resolved = resolveDroppedFiles([first, duplicate, inaccessible], (file) => {
      if (file === inaccessible) throw new Error("unavailable");
      return "/tmp/input.txt";
    });
    expect(resolved).toMatchObject({ paths: ["/tmp/input.txt"], duplicates: 1, unavailable: 1 });
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0]).toMatchObject({ name: "Error", message: "unavailable" });
  });

  it("preserves a renderer exception and its cause for the app log", () => {
    const cause = new TypeError("inner");
    const error = new Error("outer", { cause });
    expect(reportableError(error)).toMatchObject({
      name: "Error",
      message: "outer",
      cause: { name: "TypeError", message: "inner" },
    });
    expect(reportableError(error).stack).toContain("outer");
  });

  it("keeps full success quiet and accounts for a partial resolution once", () => {
    expect(summarizeDroppedFiles(
      "Added",
      { paths: ["/a"], duplicates: 0, unavailable: 0, errors: [] },
      { changed: true, accepted: 1, result: null },
    )).toBeNull();

    expect(summarizeDroppedFiles(
      "Added",
      { paths: ["/a"], duplicates: 1, unavailable: 2, errors: [] },
      { changed: true, accepted: 1, result: null },
    )).toEqual({
      message: "Added 1 input. 1 dropped item repeated the same local path. 2 dropped items were not available as a local path.",
      severity: "warning",
    });
  });

  it("keeps duplicate-only outcomes informational and unexpected resolution failures erroneous", () => {
    expect(summarizeDroppedFiles(
      "Added",
      { paths: ["/a"], duplicates: 1, unavailable: 0, errors: [] },
      { changed: true, accepted: 1, result: null },
    )?.severity).toBe("information");

    expect(summarizeDroppedFiles(
      "Added",
      {
        paths: [],
        duplicates: 0,
        unavailable: 1,
        errors: [{ name: "Error", message: "bridge failed" }],
      },
      { changed: false, accepted: 0, result: null },
    )?.severity).toBe("error");
  });
});
