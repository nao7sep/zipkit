/**
 * Arcname mapping tests: the anchor for a single directory (always flattened to
 * the root) and a single file, multiple basename-prefixed inputs, the path join,
 * and the same-prefix collision check.
 */

import { describe, expect, it } from "vitest";
import { PolicyError } from "../../../src/sdk/errors.js";
import {
  checkAnchorCollisions,
  computeAnchor,
  joinArchivePath,
  normalizeInputs,
} from "../../../src/sdk/plan/arcname.js";

describe("normalizeInputs", () => {
  it("resolves string inputs against the cwd", () => {
    const inputs = normalizeInputs(["a", "sub/b"], "/work");
    expect(inputs[0]).toEqual({ path: "/work/a" });
    expect(inputs[1]).toEqual({ path: "/work/sub/b" });
  });
});

describe("computeAnchor", () => {
  it("flattens a single directory to the root", () => {
    expect(computeAnchor({ path: "/a/b/proj" }, true, 1)).toBe("");
  });

  it("anchors a single file at its basename", () => {
    expect(computeAnchor({ path: "/a/b/file.txt" }, false, 1)).toBe("file.txt");
  });

  it("prefixes multiple directory inputs by their basename", () => {
    expect(computeAnchor({ path: "/a/b/x" }, true, 2)).toBe("x");
    expect(computeAnchor({ path: "/c/d/y" }, true, 2)).toBe("y");
  });

  it("anchors a file among multiple inputs at its basename", () => {
    expect(computeAnchor({ path: "/a/b/file.txt" }, false, 3)).toBe("file.txt");
  });
});

describe("joinArchivePath", () => {
  it("joins anchor and relative remainder", () => {
    expect(joinArchivePath("", "x/y")).toBe("x/y");
    expect(joinArchivePath("p", "x")).toBe("p/x");
    expect(joinArchivePath("p", "")).toBe("p");
    expect(joinArchivePath("p", "/x/")).toBe("p/x");
  });
});

describe("checkAnchorCollisions", () => {
  it("rejects two inputs that resolve to the same non-empty prefix", () => {
    const inputs = normalizeInputs(["/a/src", "/b/src"], "/");
    expect(() => checkAnchorCollisions(inputs, ["src", "src"])).toThrow(PolicyError);
  });

  it("allows distinct prefixes and ignores root-level merges", () => {
    const inputs = normalizeInputs(["/a", "/b", "/c"], "/");
    expect(() => checkAnchorCollisions(inputs, ["a", "b", ""])).not.toThrow();
    expect(() => checkAnchorCollisions(inputs, ["", "", ""])).not.toThrow();
  });
});
