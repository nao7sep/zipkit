/**
 * Handing a plan to another process: a structured clone of a plan loses the
 * writer's instructions, while one of exportPlan's package keeps them, so the
 * plan can be written on the far side exactly as beside plan().
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportPlan, importPlan, ZipKit, type PlanData } from "../src/index.ts";
import { invalidError } from "./helpers/errors.ts";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "zipkit-transfer-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("exportPlan and importPlan", () => {
  it("carry a plan across a structured clone so it can still be written", async () => {
    const input = path.join(dir, "docs");
    await mkdir(input);
    await writeFile(path.join(input, "a.txt"), "hello");
    const output = path.join(dir, "docs.zip");
    const plan = await new ZipKit().plan({ inputs: [input], output });

    // A plain copy cannot be written: the writer's instructions stay behind.
    await expect(new ZipKit().write(structuredClone(plan))).rejects.toMatchObject({ code: "write.no-internals" });

    const across = structuredClone(exportPlan(plan));
    const written = await new ZipKit().write(importPlan(across));
    expect(written.output).toBe(output);
    expect((await new ZipKit().verify(output, { manifest: true })).ok).toBe(true);
    expect((await readFile(output)).length).toBeGreaterThan(0);
  });

  it("refuse a plan that did not come from plan(), and anything exportPlan did not make", () => {
    expect(() => exportPlan({ mode: "plan" } as unknown as PlanData)).toThrow(invalidError);
    expect(() => importPlan({ format: "something-else", plan: {}, internals: {} } as never)).toThrow(invalidError);
    expect(() => importPlan(null as never)).toThrow(invalidError);
  });
});
