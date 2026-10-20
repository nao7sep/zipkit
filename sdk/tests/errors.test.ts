/**
 * The error contract consumers branch on: every code declared once with its
 * kind, an error that crosses a process boundary as plain data and is still
 * recognized, and `effect` saying whether a failure may have left something
 * behind.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ERROR_CODES, isZipKitError, ZipKit, ZipKitError } from "../src/index.ts";
import { stallError, toAbortError, withUnknownEffect } from "../src/errors.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "zipkit-errors-")); });
afterEach(() => rm(root, { recursive: true, force: true }));

describe("ZipKitError", () => {
  it("takes its kind from the code table, so a code cannot carry two kinds", () => {
    for (const [code, kind] of Object.entries(ERROR_CODES)) {
      expect(new ZipKitError(code as keyof typeof ERROR_CODES, "x").kind).toBe(kind);
    }
    expect(new ZipKitError("spec.invalid", "bad").effect).toBe("none");
    expect(toAbortError(new Error("stop"))).toMatchObject({ code: "operation.cancelled", kind: "cancelled", effect: "none" });
  });

  it("crosses a process boundary as plain data the guard still recognizes", () => {
    const err = stallError("publish", "/out/a.zip", 30_000, true);
    const data = structuredClone(JSON.parse(JSON.stringify(err)));
    expect(data).toEqual({
      name: "ZipKitError", code: "io.stalled", kind: "unavailable", effect: "unknown",
      message: "publish did not finish within 30000 ms and may still complete: /out/a.zip",
      subject: "/out/a.zip", details: { operation: "publish", timeoutMs: 30_000 },
    });
    expect(isZipKitError(data)).toBe(true);
    expect(isZipKitError(err)).toBe(true);
  });

  it("recognizes only a known code with its own kind", () => {
    const base = { name: "ZipKitError", code: "spec.invalid", kind: "invalid", effect: "none", message: "m" };
    expect(isZipKitError(base)).toBe(true);
    expect(isZipKitError({ ...base, code: "made.up" })).toBe(false);
    expect(isZipKitError({ ...base, kind: "unavailable" })).toBe(false);
    expect(isZipKitError({ ...base, effect: "maybe" })).toBe(false);
    expect(isZipKitError(new Error("plain"))).toBe(false);
    expect(isZipKitError(null)).toBe(false);
  });

  it("marks a failure that may have left output behind, keeping everything else", () => {
    const cause = new Error("disk");
    const err = new ZipKitError("io.failed", "cannot write a.zip", { cause, subject: "a.zip" });
    const marked = withUnknownEffect(err) as ZipKitError;
    expect(marked).toMatchObject({ code: "io.failed", effect: "unknown", subject: "a.zip", cause });
    expect(withUnknownEffect(marked)).toBe(marked);
    const plain = new Error("not ours");
    expect(withUnknownEffect(plain)).toBe(plain);
  });
});

describe("verification of the two headers", () => {
  it("fails an entry whose local header disagrees with its central record, as tools that walk local headers would read it", async () => {
    const file = path.join(root, "a.txt");
    await writeFile(file, "alpha");
    const archive = path.join(root, "a.zip");
    await new ZipKit().create({ inputs: [file], output: archive });
    expect((await new ZipKit().verify({ archive, manifest: true })).ok).toBe(true);
    const bytes = await readFile(archive);
    // The first entry's local header starts the file; its name follows the 30-byte header.
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    bytes[30] = "z".charCodeAt(0);
    await writeFile(archive, bytes);
    const result = await new ZipKit().verify({ archive });
    expect(result.ok).toBe(false);
    expect(result.summary.localMismatched).toBe(1);
    expect(result.findings).toEqual([expect.objectContaining({ rule: "verify.local-mismatch", path: "a.txt", severity: "error" })]);
  });
});
