/**
 * Unit tests for output-path resolution (pure path arithmetic): an explicit
 * output, a given folder and name, and every inference — a single folder or
 * file, a `.zip` input never named as itself, several inputs in one parent, and
 * several in different parents, which need a folder or a name.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyError } from "../../src/errors.js";
import { resolveOutputPath } from "../../src/scan/output.js";
import type { ResolvedInput } from "../../src/plan/arcname.js";

const cwd = path.resolve("/work");
const input = (p: string): ResolvedInput => ({ path: path.resolve(cwd, p) });
const at = (...parts: string[]) => path.join(cwd, ...parts);

describe("resolveOutputPath", () => {
  it("honors an explicit output, resolved against cwd", () => {
    expect(resolveOutputPath({ output: "out/archive.zip" }, [input("proj")], [true], cwd)).toBe(at("out/archive.zip"));
  });

  it("writes <dirname>.zip beside a single folder, and <stem>.zip beside a single file", () => {
    expect(resolveOutputPath({}, [input("proj")], [true], cwd)).toBe(at("proj.zip"));
    expect(resolveOutputPath({}, [input("notes.txt")], [false], cwd)).toBe(at("notes.zip"));
    expect(resolveOutputPath({}, [input("README")], [false], cwd)).toBe(at("README.zip"));
    expect(resolveOutputPath({}, [input("photos.v2")], [true], cwd)).toBe(at("photos.v2.zip"));
  });

  it("never names an archive of a .zip as the .zip itself", () => {
    expect(resolveOutputPath({}, [input("foo.zip")], [false], cwd)).toBe(at("foo.zip.zip"));
  });

  it("writes <parent>.zip when several inputs share one parent", () => {
    expect(resolveOutputPath({}, [input("bundle/a"), input("bundle/b.txt")], [true, false], cwd)).toBe(at("bundle", "bundle.zip"));
  });

  it("never names an archive of several inputs onto one of them, whatever its case or Unicode form", () => {
    expect(resolveOutputPath({}, [input("p/p.zip"), input("p/a")], [false, true], cwd)).toBe(at("p", "p.zip.zip"));
    expect(resolveOutputPath({}, [input("p/P.ZIP"), input("p/a")], [true, true], cwd)).toBe(at("p", "p.zip.zip"));
    const nfd = "Cafe\u0301";
    expect(resolveOutputPath({}, [input(`Café/${nfd}.zip`), input("Café/a")], [false, true], cwd)).toBe(at("Café", "Café.zip.zip"));
    // A name the caller gives is taken as given: the scan refuses it if it is an input.
    expect(resolveOutputPath({ outputName: "a" }, [input("p/a.zip"), input("p/b")], [false, false], cwd)).toBe(at("p", "a.zip"));
  });

  it("names the archive of a root archive.zip, and of several things at a root after the first", () => {
    expect(resolveOutputPath({}, [{ path: path.parse(cwd).root }], [true], cwd)).toBe(path.join(path.parse(cwd).root, "archive.zip"));
    const root = path.parse(cwd).root;
    expect(resolveOutputPath({}, [{ path: path.join(root, "Photos") }, { path: path.join(root, "Docs") }], [true, true], cwd))
      .toBe(path.join(root, "Photos.zip"));
  });

  it("takes a given folder and name, adding .zip to a name without it", () => {
    expect(resolveOutputPath({ outputDir: "/out", outputName: "delivery" }, [input("proj")], [true], cwd)).toBe(path.resolve("/out/delivery.zip"));
    expect(resolveOutputPath({ outputDir: "/out", outputName: "Delivery.ZIP" }, [input("proj")], [true], cwd)).toBe(path.resolve("/out/Delivery.ZIP"));
    expect(resolveOutputPath({ outputDir: "/out" }, [input("strategy.md")], [false], cwd)).toBe(path.resolve("/out/strategy.zip"));
    expect(resolveOutputPath({ outputName: "delivery" }, [input("proj")], [true], cwd)).toBe(at("delivery.zip"));
  });

  it("archives inputs in different parents into a given folder or, given only a name, beside the first", () => {
    const inputs = [input("one/a"), input("two/b")];
    expect(resolveOutputPath({ outputDir: "/out" }, inputs, [true, true], cwd)).toBe(path.resolve("/out/a.zip"));
    expect(resolveOutputPath({ outputName: "both" }, inputs, [true, true], cwd)).toBe(at("one", "both.zip"));
    expect(() => resolveOutputPath({}, inputs, [true, true], cwd)).toThrow(PolicyError);
  });

  it("refuses to infer from an empty input list", () => {
    expect(() => resolveOutputPath({}, [], [], cwd)).toThrow(PolicyError);
  });
});
