/**
 * Tests for the GUI's output-path composition. The contract: both directory and
 * file name empty stays empty (the SDK infers beside the input); each defaults
 * from the first input when the other is set; the default NAME mirrors the SDK's
 * inference — a directory keeps its name, a file drops its extension, and a `.zip`
 * input keeps its full name (→ `.zip.zip`, never colliding with itself); a typed
 * name gains a `.zip` if missing; a leading `~` in the directory is expanded; and
 * a *relative* typed directory is rejected — never handed to the SDK, where it
 * would resolve against the unpredictable working directory (`/` for a
 * double-clicked app). The pure `composeOutputPath` is tested directly (the
 * file-vs-directory bit is passed in; `resolveOutputPath` supplies it by stat,
 * the untested I/O edge).
 */

import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { composeOutputPath } from "../../../src/gui/main/output.js";

const dirInput = path.join(path.sep, "data", "photos"); // a directory input
const fileInput = path.join(path.sep, "data", "strategy.md"); // a file input
const out = path.join(path.sep, "out");

describe("composeOutputPath", () => {
  it("stays empty when both directory and name are blank, so the SDK infers", () => {
    expect(composeOutputPath("", "", [dirInput], true)).toBe("");
    expect(composeOutputPath("   ", "  ", [dirInput], true)).toBe("");
  });

  it("keeps a directory's name when auto-naming into a chosen directory", () => {
    expect(composeOutputPath(out, "", [dirInput], true)).toBe(path.join(out, "photos.zip"));
  });

  it("drops a file's extension when auto-naming (strategy.md -> strategy.zip)", () => {
    expect(composeOutputPath(out, "", [fileInput], false)).toBe(path.join(out, "strategy.zip"));
  });

  it("keeps a dotted directory name (does not strip what looks like an extension)", () => {
    const dotted = path.join(path.sep, "data", "my.project");
    expect(composeOutputPath(out, "", [dotted], true)).toBe(path.join(out, "my.project.zip"));
  });

  it("does not collide with a .zip input: foo.zip -> foo.zip.zip", () => {
    const zipInput = path.join(path.sep, "data", "foo.zip");
    expect(composeOutputPath(out, "", [zipInput], false)).toBe(path.join(out, "foo.zip.zip"));
  });

  it("defaults the directory to the input's parent when only the name is set", () => {
    expect(composeOutputPath("", "album", [dirInput], false)).toBe(
      path.join(path.sep, "data", "album.zip"),
    );
  });

  it("composes directory + name, adding .zip when missing and keeping it when present", () => {
    expect(composeOutputPath(out, "album", [dirInput], true)).toBe(path.join(out, "album.zip"));
    expect(composeOutputPath(out, "album.zip", [dirInput], true)).toBe(path.join(out, "album.zip"));
    expect(composeOutputPath(out, "album.ZIP", [dirInput], true)).toBe(path.join(out, "album.ZIP"));
  });

  it("expands a leading ~ in the directory to the home directory", () => {
    expect(composeOutputPath("~/Desktop", "out", [dirInput], true)).toBe(
      path.join(homedir(), "Desktop", "out.zip"),
    );
  });

  it("rejects a relative directory rather than resolving it against the cwd", () => {
    expect(() => composeOutputPath("out", "x", [dirInput], true)).toThrow(/absolute/);
    expect(() => composeOutputPath("./sub", "x", [dirInput], true)).toThrow(/absolute/);
  });
});
