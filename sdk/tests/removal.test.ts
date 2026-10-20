/**
 * The checks before the originals are removed: the archive must not sit inside
 * an input (removing the input would take the archive with it), must verify,
 * and the inputs must still match it. A bug here risks the user's only copy,
 * so the boundary cases and the order of the checks are pinned.
 */

import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { checkRemoval, outputInsideInputs as check, type RemovalSteps } from "../src/removal.ts";
import { explainRemoved, onDisk } from "../src/compare/sources.ts";
import { ZipKit, ZipKitError } from "../src/index.ts";
import { realVolume } from "./helpers/volume.ts";

const outputInsideInputs = (output: string, inputs: string[]): Promise<boolean> =>
  check(output, inputs, realVolume());
import { createDirectoryLink, createFileLink, fileSymlinksSupported } from "./helpers/symlink.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-safety-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
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

  it("uses physical identity for an input directory link", async () => {
    const root = await fixture();
    const input = path.join(root, "real");
    const inputAlias = path.join(root, "input-alias");
    await mkdir(input);
    const output = path.join(input, "out.zip");
    await writeFile(output, "zip");
    await createDirectoryLink(input, inputAlias);
    await expect(outputInsideInputs(output, [inputAlias])).resolves.toBe(true);
  });

  it.runIf(fileSymlinksSupported)("uses physical identity for an output file symlink", async () => {
    const root = await fixture();
    const input = path.join(root, "real");
    const outputAlias = path.join(root, "output-alias.zip");
    await mkdir(input);
    const output = path.join(input, "out.zip");
    await writeFile(output, "zip");
    await createFileLink(output, outputAlias);
    await expect(outputInsideInputs(outputAlias, [input])).resolves.toBe(true);
  });
});

describe("checkRemoval", () => {
  const same = { matches: true, added: [], missing: [], changed: [], unlisted: [] };
  const report = { summary: { total: 1, crc32Failed: 1, unreadable: 0, localMismatched: 0, sha256Mismatched: 0, manifestMismatched: 0 }, missing: [], extra: [], findings: [] };
  const steps = (over: Partial<RemovalSteps> = {}, ran: string[] = []): RemovalSteps => ({
    state: async () => (ran.push("state"), { kind: "present", fingerprint: "f1" }),
    inside: async () => (ran.push("inside"), false),
    verify: async () => (ran.push("verify"), { ok: true, report }),
    compare: async () => (ran.push("compare"), same),
    ...over,
  });
  const check = (s: RemovalSteps) => checkRemoval(s, "/out/a.zip");

  it("runs every check in order and passes with the fingerprint that verified", async () => {
    const ran: string[] = [];
    expect(await check(steps({}, ran))).toEqual({ refusal: null, verified: { fingerprint: "f1" } });
    expect(ran).toEqual(["state", "inside", "verify", "compare"]);
  });

  it("stops at the first refusal, carrying what failed, and refuses with a ZipKit error when a check cannot finish", async () => {
    const ran: string[] = [];
    expect(await check(steps({ inside: async () => true }, ran))).toEqual({ refusal: { reason: "inside" }, verified: null });
    expect(ran).toEqual(["state"]);
    expect((await check(steps({ verify: async () => ({ ok: false, report }) }))).refusal).toEqual({ reason: "verify-failed", report });
    const stalled = new ZipKitError("io.stalled", "stalled", { subject: "/out/a.zip", details: { operation: "read", timeoutMs: 1 } });
    expect(await check(steps({ verify: async () => { throw stalled; } })))
      .toEqual({ refusal: { reason: "error", step: "verify", error: stalled.toJSON() }, verified: null });
    // A raw file-system failure arrives classified, naming the archive.
    const missing = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    expect((await check(steps({ inside: async () => { throw missing; } }))).refusal)
      .toMatchObject({ reason: "error", step: "location", error: { code: "path.missing", kind: "unavailable", subject: "/out/a.zip" } });
    // A later refusal still says the archive verified.
    expect(await check(steps({ compare: async () => { throw stalled; } })))
      .toEqual({ refusal: { reason: "error", step: "recheck", error: stalled.toJSON() }, verified: { fingerprint: "f1" } });
    // The refusal is plain data, so it crosses a process boundary as it is.
    const { refusal } = await check(steps({ compare: async () => { throw stalled; } }));
    expect(refusal).not.toBeInstanceOf(Error);
    expect(structuredClone(refusal)).toEqual(refusal);
    // A fault in the SDK itself is not taken for the disk's.
    expect((await check(steps({ verify: async () => { throw new TypeError("bug"); } }))).refusal)
      .toMatchObject({ reason: "error", step: "verify", error: { code: "internal.unexpected", kind: "internal" } });
  });

  it("throws a cancellation from any step instead of answering", async () => {
    const aborted = new ZipKitError("operation.cancelled", "stop");
    await expect(check(steps({ state: async () => { throw aborted; } }))).rejects.toBe(aborted);
    await expect(check(steps({ verify: async () => { throw aborted; } }))).rejects.toBe(aborted);
  });

  it("does not count as missing what came from an input already removed, unless another input shares its name", () => {
    const comparison = { matches: false, added: [], missing: ["b/x.txt", "a/y.txt"], changed: [], unlisted: [] };
    expect(explainRemoved(comparison, ["/one/a"], ["/two/b"])).toEqual({ ...comparison, missing: ["a/y.txt"], matches: false });
    expect(explainRemoved({ ...comparison, missing: ["b/x.txt"] }, ["/one/a"], ["/two/b"]).matches).toBe(true);
    expect(explainRemoved({ ...comparison, missing: ["a/x.txt"] }, ["/one/a"], ["/two/a"]).matches).toBe(false);
  });

  it("names places on disk: where an item was found, or the input its recorded path starts with", () => {
    const comparison = { matches: false, added: ["a/new.txt"], missing: ["a/gone.txt", "b/old.txt"], changed: ["a/x.txt"], unlisted: [] };
    const found = new Map([["a/new.txt", ["/one/a/new.txt"]], ["a/x.txt", ["/one/a/x.txt", "/two/a/x.txt"]]]);
    expect(onDisk(comparison, found, ["/one/a"], ["/gone/b"])).toEqual({
      matches: false,
      added: ["/one/a/new.txt"],
      missing: [path.join("/gone/b", "old.txt"), path.join("/one/a", "gone.txt")],
      changed: ["/one/a/x.txt", "/two/a/x.txt"],
      unlisted: [],
    });
    // An input still present wins over a removed one of the same name.
    expect(onDisk({ ...comparison, added: [], changed: [], missing: ["a/y.txt"] }, new Map(), ["/one/a"], ["/old/a"]).missing).toEqual([path.join("/one/a", "y.txt")]);
  });
});

describe("ZipKit.checkRemoval", () => {
  it("passes a fresh archive, then refuses once the originals change or the archive is altered", async () => {
    const root = await fixture();
    const a = path.join(root, "a"), b = path.join(root, "b");
    await mkdir(a); await mkdir(b);
    await writeFile(path.join(a, "1.txt"), "one"); await writeFile(path.join(b, "2.txt"), "two");
    const zip = new ZipKit();
    const archive = path.join(root, "out.zip");
    await zip.create({ inputs: [a, b], output: archive });
    const passed = await zip.checkRemoval({ spec: { inputs: [a, b] }, archive });
    expect(passed.refusal).toBeNull();
    expect(passed.verified?.fingerprint).toEqual(expect.any(String));
    // Only `a` is left to remove, `b` already went: its entries are expected.
    await rm(b, { recursive: true });
    expect((await zip.checkRemoval({ spec: { inputs: [a] }, archive, removed: [b] })).refusal).toBeNull();
    expect((await zip.checkRemoval({ spec: { inputs: [a] }, archive })).refusal).toMatchObject({ reason: "changed", comparison: { missing: ["b/2.txt"] } });
    await writeFile(path.join(a, "late.txt"), "late");
    expect((await zip.checkRemoval({ spec: { inputs: [a] }, archive, removed: [b] })).refusal)
      .toMatchObject({ reason: "changed", comparison: { added: [path.join(a, "late.txt")] } });
    await rm(path.join(a, "late.txt"));
    // Damaged, the archive can no longer be read.
    await appendFile(archive, "trailing");
    expect((await zip.checkRemoval({ spec: { inputs: [a] }, archive, removed: [b] })).refusal)
      .toMatchObject({ reason: "error", step: "verify", error: { kind: "invalid" } });
  });

  it("verifies against a manifest made under another name, refuses relative inputs, and throws when cancelled", async () => {
    const root = await fixture();
    const input = path.join(root, "proj");
    await mkdir(input);
    await writeFile(path.join(input, "a.txt"), "a");
    const zip = new ZipKit();
    const archive = path.join(root, "proj.zip");
    const policy = { manifest: { name: "files.json" } };
    await zip.create({ inputs: [input], output: archive, policy });
    expect((await zip.checkRemoval({ spec: { inputs: [input], policy }, archive })).refusal).toBeNull();
    await expect(zip.checkRemoval({ spec: { inputs: ["proj"] }, archive })).rejects.toMatchObject({ kind: "invalid" });
    const controller = new AbortController();
    controller.abort();
    await expect(zip.checkRemoval({ spec: { inputs: [input] }, archive }, { signal: controller.signal })).rejects.toMatchObject({ code: "operation.cancelled", kind: "cancelled" });
  });

  it("refuses an archive inside an input, and ignores how the spec would have named it", async () => {
    const root = await fixture();
    const input = path.join(root, "proj");
    await mkdir(input);
    await writeFile(path.join(input, "a.txt"), "a");
    const zip = new ZipKit();
    const archive = path.join(input, "proj.zip");
    await zip.create({ inputs: [input], output: archive });
    expect((await zip.checkRemoval({ spec: { inputs: [input], outputDir: root, outputName: "x" }, archive })).refusal).toEqual({ reason: "inside" });
  });
});
