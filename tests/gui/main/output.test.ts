/**
 * Tests for the GUI's output-path composition. The contract: both folder and
 * file name empty stays empty (the SDK infers beside the input); each defaults
 * from the first input when the other is set (folder -> input's parent, name ->
 * input's basename + .zip); a typed name gains a `.zip` if missing; a leading `~`
 * in the folder is expanded to the home directory; and a *relative* typed folder
 * is rejected — never handed to the SDK, where it would resolve against the
 * unpredictable working directory (`/` for a double-clicked app).
 */

import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { resolveOutputPath } from "../../../src/gui/main/output.js";

const input = path.join(path.sep, "data", "photos");

describe("resolveOutputPath", () => {
  it("stays empty when both folder and name are blank, so the SDK infers", () => {
    expect(resolveOutputPath("", "", [input])).toBe("");
    expect(resolveOutputPath("   ", "  ", [input])).toBe("");
  });

  it("defaults the name from the input's basename when only the folder is set", () => {
    const dir = path.join(path.sep, "out");
    expect(resolveOutputPath(dir, "", [input])).toBe(path.join(dir, "photos.zip"));
  });

  it("defaults the folder to the input's parent when only the name is set", () => {
    expect(resolveOutputPath("", "album", [input])).toBe(path.join(path.sep, "data", "album.zip"));
  });

  it("composes folder + name, adding .zip when missing and keeping it when present", () => {
    const dir = path.join(path.sep, "out");
    expect(resolveOutputPath(dir, "album", [input])).toBe(path.join(dir, "album.zip"));
    expect(resolveOutputPath(dir, "album.zip", [input])).toBe(path.join(dir, "album.zip"));
    expect(resolveOutputPath(dir, "album.ZIP", [input])).toBe(path.join(dir, "album.ZIP"));
  });

  it("expands a leading ~ in the folder to the home directory", () => {
    expect(resolveOutputPath("~/Desktop", "out", [input])).toBe(
      path.join(homedir(), "Desktop", "out.zip"),
    );
  });

  it("rejects a relative folder rather than resolving it against the cwd", () => {
    expect(() => resolveOutputPath("out", "x", [input])).toThrow(/absolute/);
    expect(() => resolveOutputPath("./sub", "x", [input])).toThrow(/absolute/);
  });
});
