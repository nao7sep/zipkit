/**
 * Arcname mapping tests: the anchor for a single directory (always flattened to
 * the root) and a single file, multiple basename-prefixed inputs, the path join,
 * and the same-prefix collision check.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  checkAnchorCollisions,
  computeAnchor,
  joinArchivePath,
  normalizeInputs,
} from "../../src/plan/arcname.ts";
import { invalidError } from "../helpers/errors.ts";

describe("normalizeInputs", () => {
  it("normalizes absolute inputs without consulting a working directory", () => {
    const root = path.join(path.parse(path.resolve(".")).root, "work");
    const inputs = normalizeInputs([path.join(root, "a", "."), path.join(root, "sub", "x", "..", "b")]);
    expect(inputs[0]).toEqual({ path: path.join(root, "a") });
    expect(inputs[1]).toEqual({ path: path.join(root, "sub", "b") });
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
    const inputs = normalizeInputs(["/a/src", "/b/src"]);
    expect(() => checkAnchorCollisions(inputs, ["src", "src"])).toThrow(invalidError);
    expect(() => checkAnchorCollisions(inputs, ["src", "src"])).toThrow(expect.objectContaining({ code: "input.prefix-collision", subject: inputs[1]!.path }));
  });

  it("allows distinct prefixes and ignores root-level merges", () => {
    const inputs = normalizeInputs(["/a", "/b", "/c"]);
    expect(() => checkAnchorCollisions(inputs, ["a", "b", ""])).not.toThrow();
    expect(() => checkAnchorCollisions(inputs, ["", "", ""])).not.toThrow();
  });
});
