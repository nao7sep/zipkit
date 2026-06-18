/**
 * Tests for the GUI's output-path boundary. The contract: an empty output stays
 * empty (the SDK infers beside the input), an absolute output passes through, a
 * leading `~` is expanded to the home directory, and a *relative* typed output is
 * rejected — never handed to the SDK, where it would resolve against the
 * unpredictable working directory (`/` for a double-clicked app).
 */

import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { resolveGuiOutput } from "../../../src/gui/main/output.js";

describe("resolveGuiOutput", () => {
  it("keeps an empty output empty so the SDK infers beside the input", () => {
    expect(resolveGuiOutput("")).toBe("");
    expect(resolveGuiOutput("   ")).toBe("");
  });

  it("passes an absolute output through (trimmed)", () => {
    const abs = path.join(path.sep, "tmp", "out.zip");
    expect(resolveGuiOutput(`  ${abs}  `)).toBe(abs);
  });

  it("expands a leading ~ to the home directory", () => {
    expect(resolveGuiOutput("~/Desktop/out.zip")).toBe(path.join(homedir(), "Desktop/out.zip"));
  });

  it("rejects a relative output rather than resolving it against the cwd", () => {
    expect(() => resolveGuiOutput("out.zip")).toThrow(/absolute/);
    expect(() => resolveGuiOutput("./sub/out.zip")).toThrow(/absolute/);
    expect(() => resolveGuiOutput("../out.zip")).toThrow(/absolute/);
  });
});
