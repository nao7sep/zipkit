/**
 * Unit tests for output-path inference (pure path arithmetic). The end-to-end
 * create tests cover only the single-directory default; the single-file,
 * multi-input-same-parent, and ambiguous-different-parents branches are the
 * documented rules verified here.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyError } from "../../../src/sdk/errors.js";
import { resolveOutputPath } from "../../../src/sdk/scan/output.js";
import type { ResolvedInput } from "../../../src/sdk/plan/arcname.js";

const cwd = path.resolve("/work");
const input = (p: string): ResolvedInput => ({ path: path.resolve(cwd, p) });

describe("resolveOutputPath", () => {
  it("honors an explicit output, resolved against cwd", () => {
    expect(resolveOutputPath("out/archive.zip", [input("proj")], [true], cwd)).toBe(
      path.join(cwd, "out/archive.zip"),
    );
  });

  it("writes <dirname>.zip beside a single directory input", () => {
    expect(resolveOutputPath(undefined, [input("proj")], [true], cwd)).toBe(path.join(cwd, "proj.zip"));
  });

  it("writes <stem>.zip beside a single file input, dropping its extension", () => {
    expect(resolveOutputPath(undefined, [input("notes.txt")], [false], cwd)).toBe(
      path.join(cwd, "notes.zip"),
    );
  });

  it("uses the basename for a single extensionless file", () => {
    expect(resolveOutputPath(undefined, [input("README")], [false], cwd)).toBe(
      path.join(cwd, "README.zip"),
    );
  });

  it("writes <parent>.zip when several inputs share one parent", () => {
    const inputs = [input("bundle/a"), input("bundle/b.txt")];
    expect(resolveOutputPath(undefined, inputs, [true, false], cwd)).toBe(
      path.join(cwd, "bundle", "bundle.zip"),
    );
  });

  it("refuses to guess when inputs live in different parents", () => {
    const inputs = [input("one/a"), input("two/b")];
    expect(() => resolveOutputPath(undefined, inputs, [true, true], cwd)).toThrow(PolicyError);
  });

  it("refuses to infer from an empty input list", () => {
    expect(() => resolveOutputPath(undefined, [], [], cwd)).toThrow(PolicyError);
  });
});
