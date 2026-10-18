/**
 * Unit tests for output-path resolution (pure path arithmetic): an explicit
 * output, a given folder and name, and every inference — a single folder or
 * file, a `.zip` input never named as itself, several inputs in one parent, and
 * several in different parents, which need a folder or a name.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveOutputPath } from "../../src/scan/output.ts";
import type { ResolvedInput } from "../../src/plan/arcname.ts";
import { invalidError } from "../helpers/errors.ts";

const cwd = path.resolve("/work");
const input = (p: string): ResolvedInput => ({ path: path.resolve(cwd, p) });
const at = (...parts: string[]) => path.join(cwd, ...parts);

describe("resolveOutputPath", () => {
  it("honors an explicit output, resolved against cwd", () => {
    expect(resolveOutputPath({ output: at("out/archive.zip") }, [input("proj")], [true]))
      .toBe(at("out/archive.zip"));
  });

  it("writes <dirname>.zip beside a single folder, and <stem>.zip beside a single file", () => {
    expect(resolveOutputPath({}, [input("proj")], [true]))
      .toBe(at("proj.zip"));
    expect(resolveOutputPath({}, [input("notes.txt")], [false]))
      .toBe(at("notes.zip"));
    expect(resolveOutputPath({}, [input("README")], [false]))
      .toBe(at("README.zip"));
    expect(resolveOutputPath({}, [input("photos.v2")], [true]))
      .toBe(at("photos.v2.zip"));
  });

  it("never names an archive of a .zip as the .zip itself", () => {
    expect(resolveOutputPath({}, [input("foo.zip")], [false]))
      .toBe(at("foo.zip.zip"));
  });

  it("writes <parent>.zip when several inputs share one parent", () => {
    expect(resolveOutputPath({}, [input("bundle/a"), input("bundle/b.txt")], [true, false]))
      .toBe(at("bundle", "bundle.zip"));
  });

  it("takes a given folder and name, adding .zip to a name without it", () => {
    expect(resolveOutputPath({ outputDir: "/out", outputName: "delivery" }, [input("proj")], [true]))
      .toBe(path.resolve("/out/delivery.zip"));
    expect(resolveOutputPath({ outputDir: "/out", outputName: "Delivery.ZIP" }, [input("proj")], [true]))
      .toBe(path.resolve("/out/Delivery.ZIP"));
    expect(resolveOutputPath({ outputDir: "/out" }, [input("strategy.md")], [false]))
      .toBe(path.resolve("/out/strategy.zip"));
    expect(resolveOutputPath({ outputName: "delivery" }, [input("proj")], [true]))
      .toBe(at("delivery.zip"));
  });

  it("archives inputs in different parents into a given folder or, given only a name, beside the first", () => {
    const inputs = [input("one/a"), input("two/b")];
    expect(resolveOutputPath({ outputDir: "/out" }, inputs, [true, true]))
      .toBe(path.resolve("/out/a.zip"));
    expect(resolveOutputPath({ outputName: "both" }, inputs, [true, true]))
      .toBe(at("one", "both.zip"));
    expect(() => resolveOutputPath({}, inputs, [true, true])) .toThrow(invalidError);
  });

  it("refuses to infer from an empty input list", () => {
    expect(() => resolveOutputPath({}, [], [])) .toThrow(invalidError);
  });
});
