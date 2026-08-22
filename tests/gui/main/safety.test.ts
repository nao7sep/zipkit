/**
 * Unit tests for the destructive-flow safety guard: refuse "move to Trash" when
 * the archive would sit inside an input (trashing the input would take the
 * archive with it). Pure path arithmetic; a bug here risks the user's new
 * archive, so the boundary cases are pinned.
 */

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { outputInsideInputs } from "../../../src/gui/main/safety.js";

async function fixture(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "zipkit-safety-"));
}

describe("outputInsideInputs", () => {
  it("is true when the output is inside an input", async () => {
    const root = await fixture();
    const input = path.join(root, "proj");
    await mkdir(input);
    const output = path.join(input, "out.zip");
    await writeFile(output, "zip");
    await expect(outputInsideInputs(output, [input])).resolves.toBe(true);
  });

  it("is true when the output equals an input", async () => {
    const root = await fixture();
    const input = path.join(root, "proj");
    await writeFile(input, "zip");
    await expect(outputInsideInputs(input, [input])).resolves.toBe(true);
  });

  it("is false when the output sits beside the input (the common case)", async () => {
    const root = await fixture();
    const input = path.join(root, "proj");
    const output = path.join(root, "proj.zip");
    await mkdir(input);
    await writeFile(output, "zip");
    await expect(outputInsideInputs(output, [input])).resolves.toBe(false);
  });

  it("uses physical identity for input and output symlink aliases", async () => {
    const root = await fixture();
    const input = path.join(root, "real");
    const inputAlias = path.join(root, "input-alias");
    const outputAlias = path.join(root, "output-alias.zip");
    await mkdir(input);
    const output = path.join(input, "out.zip");
    await writeFile(output, "zip");
    await symlink(input, inputAlias);
    await symlink(output, outputAlias);
    await expect(outputInsideInputs(output, [inputAlias])).resolves.toBe(true);
    await expect(outputInsideInputs(outputAlias, [input])).resolves.toBe(true);
  });
});
