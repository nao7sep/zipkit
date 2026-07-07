/**
 * Unit tests for the destructive-flow safety guard: refuse "move to Trash" when
 * the archive would sit inside an input (trashing the input would take the
 * archive with it). Pure path arithmetic; a bug here risks the user's new
 * archive, so the boundary cases are pinned.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { outputInsideInputs } from "../../../src/gui/main/safety.js";

const root = path.resolve("/work");

describe("outputInsideInputs", () => {
  it("is true when the output is inside an input", () => {
    expect(outputInsideInputs(path.join(root, "proj", "out.zip"), [path.join(root, "proj")])).toBe(true);
  });

  it("is true when the output equals an input", () => {
    expect(outputInsideInputs(path.join(root, "proj"), [path.join(root, "proj")])).toBe(true);
  });

  it("is false when the output sits beside the input (the common case)", () => {
    expect(outputInsideInputs(path.join(root, "proj.zip"), [path.join(root, "proj")])).toBe(false);
  });

  it("is false for a sibling that merely shares a name prefix", () => {
    expect(outputInsideInputs(path.join(root, "proj-archive.zip"), [path.join(root, "proj")])).toBe(false);
  });

  it("checks every input, not just the first", () => {
    const inputs = [path.join(root, "a"), path.join(root, "b")];
    expect(outputInsideInputs(path.join(root, "b", "out.zip"), inputs)).toBe(true);
  });
});
