/**
 * The GUI's output-folder boundary: what the user set reaches the SDK as a
 * folder and a file name, each left out when blank for the SDK to infer; a
 * leading `~` in the folder is expanded; and a *relative* typed folder is
 * rejected — never handed to the SDK, where it would resolve against the
 * unpredictable working directory (`/` for a double-clicked app).
 */

import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { outputRequest } from "../../../src/gui/main/output.js";

const out = path.join(path.sep, "out");

describe("outputRequest", () => {
  it("leaves both out when both are blank, so the SDK infers beside the input", () => {
    expect(outputRequest("", "")).toEqual({});
    expect(outputRequest("", "   ")).toEqual({});
  });

  it("passes a chosen folder as it is, spaces and all, and a typed name trimmed", () => {
    expect(outputRequest(path.join(out, " spaced "), "")).toEqual({ outputDir: path.join(out, " spaced ") });
    expect(outputRequest("", " delivery ")).toEqual({ outputName: "delivery" });
    expect(outputRequest(out, "delivery.zip")).toEqual({ outputDir: out, outputName: "delivery.zip" });
  });

  it("expands a leading ~ in the folder to the home directory", () => {
    expect(outputRequest("~/Desktop", "")).toEqual({ outputDir: path.join(homedir(), "Desktop") });
    expect(outputRequest("~", "")).toEqual({ outputDir: homedir() });
  });

  it("rejects a relative folder rather than resolving it against the cwd", () => {
    expect(() => outputRequest("relative/dir", "")).toThrow(/absolute/);
  });
});
