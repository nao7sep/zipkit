/**
 * Arcname and root mapping tests (§10.4): the anchor for a single directory
 * (flatten default and `--wrap`), multiple basename-prefixed inputs, `as`
 * overrides, root-relative anchoring, the root/as conflict, and the
 * same-prefix collision check.
 */

import { describe, expect, it } from "vitest";
import { PolicyError } from "../../src/errors.js";
import {
  checkAnchorCollisions,
  computeAnchor,
  joinArchivePath,
  normalizeInputs,
} from "../../src/plan/arcname.js";

describe("normalizeInputs", () => {
  it("resolves string and object inputs against the cwd", () => {
    const inputs = normalizeInputs(["a", { path: "b", as: "top", flatten: false }], "/work");
    expect(inputs[0]).toEqual({ path: "/work/a" });
    expect(inputs[1]).toEqual({ path: "/work/b", as: "top", flatten: false });
  });
});

describe("computeAnchor", () => {
  it("flattens a single directory to the root by default", () => {
    expect(computeAnchor({ path: "/a/b/proj" }, true, 1, undefined)).toBe("");
  });

  it("keeps the directory name under --wrap (flatten:false)", () => {
    expect(computeAnchor({ path: "/a/b/proj", flatten: false }, true, 1, undefined)).toBe("proj");
  });

  it("anchors a single file at its basename", () => {
    expect(computeAnchor({ path: "/a/b/file.txt" }, false, 1, undefined)).toBe("file.txt");
  });

  it("prefixes multiple inputs by their basename", () => {
    expect(computeAnchor({ path: "/a/b/x" }, true, 2, undefined)).toBe("x");
  });

  it("lets a multi-input flatten:true land at the root", () => {
    expect(computeAnchor({ path: "/a/b/x", flatten: true }, true, 2, undefined)).toBe("");
  });

  it("honors an explicit as", () => {
    expect(computeAnchor({ path: "/a/b/proj", as: "top/inner" }, true, 1, undefined)).toBe(
      "top/inner",
    );
  });

  it("anchors relative to root", () => {
    expect(computeAnchor({ path: "/root/sub/x" }, true, 1, "/root")).toBe("sub/x");
    expect(computeAnchor({ path: "/root" }, true, 1, "/root")).toBe("");
  });

  it("rejects root combined with as or flatten", () => {
    expect(() => computeAnchor({ path: "/root/x", as: "y" }, true, 1, "/root")).toThrow(PolicyError);
    expect(() => computeAnchor({ path: "/root/x", flatten: false }, true, 1, "/root")).toThrow(
      PolicyError,
    );
  });

  it("rejects an input outside root", () => {
    expect(() => computeAnchor({ path: "/elsewhere/x" }, true, 1, "/root")).toThrow(PolicyError);
  });

  it("rejects an `as` that resolves to an empty path", () => {
    for (const as of ["", "/", ".", "a/.."]) {
      expect(() => computeAnchor({ path: "/x/f.txt", as }, false, 1, undefined)).toThrow(PolicyError);
    }
  });

  it("rejects an `as` that escapes the root", () => {
    expect(() => computeAnchor({ path: "/x/f.txt", as: "../y" }, false, 1, undefined)).toThrow(
      PolicyError,
    );
  });

  it("rejects a file input that is the root itself, but allows a directory", () => {
    expect(() => computeAnchor({ path: "/root" }, false, 1, "/root")).toThrow(PolicyError);
    expect(computeAnchor({ path: "/root" }, true, 1, "/root")).toBe("");
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
