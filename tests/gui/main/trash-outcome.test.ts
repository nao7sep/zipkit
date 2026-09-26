import { describe, expect, it } from "vitest";
import { describeOriginalsTrash, trashConfirmed } from "../../../src/gui/main/trash-outcome.js";

describe("trash outcome", () => {
  it("is confirmed only when every path moved", () => {
    expect(trashConfirmed({ moved: ["/a"], failed: [], unconfirmed: [] })).toBe(true);
    expect(trashConfirmed({ moved: [], failed: [{ path: "/a", message: "x" }], unconfirmed: [] })).toBe(false);
    expect(trashConfirmed({ moved: [], failed: [], unconfirmed: ["/a"] })).toBe(false);
  });

  it("names moved, kept, and still-moving originals separately", () => {
    expect(
      describeOriginalsTrash({
        moved: ["/a", "/b"],
        failed: [{ path: "/c", message: "denied" }],
        unconfirmed: ["/d"],
      }),
    ).toBe(
      "2 originals were moved to recoverable Trash; 1 was kept; 1 was still being moved and may yet reach recoverable Trash.",
    );
  });

  it("omits the buckets that are empty", () => {
    expect(describeOriginalsTrash({ moved: [], failed: [], unconfirmed: ["/a", "/b"] })).toBe(
      "0 originals were moved to recoverable Trash; 2 were still being moved and may yet reach recoverable Trash.",
    );
  });
});
