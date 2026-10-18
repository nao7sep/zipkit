/**
 * The checks before the originals are removed: the archive must not sit inside
 * an input (removing the input would take the archive with it), must verify,
 * and the inputs must still match it. A bug here risks the user's only copy,
 * so the boundary cases and the order of the checks are pinned.
 */

import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { checkRemoval, explainRemoved, outputInsideInputs as check, type RemovalSteps } from "../src/removal.ts";
import { ZipKit } from "../src/index.ts";
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
  const steps = (over: Partial<RemovalSteps> = {}, ran: string[] = []): RemovalSteps => ({
    state: async () => (ran.push("state"), { kind: "present", fingerprint: "f1" }),
    inside: async () => (ran.push("inside"), false),
    verify: async () => (ran.push("verify"), true),
    compare: async () => (ran.push("compare"), same),
    ...over,
  });

  it("runs every check in order and passes with the fingerprint that verified", async () => {
    const ran: string[] = [];
    expect(await checkRemoval(steps({}, ran), ["/in"], [])).toEqual({ refusal: null, verified: { fingerprint: "f1" } });
    expect(ran).toEqual(["state", "inside", "verify", "compare"]);
  });

  it("stops at the first refusal, and refuses rather than throws when a check cannot finish", async () => {
    const ran: string[] = [];
    expect(await checkRemoval(steps({ inside: async () => true }, ran), ["/in"], [])).toEqual({ refusal: { reason: "inside" }, verified: null });
    expect(ran).toEqual(["state"]);
    expect((await checkRemoval(steps({ verify: async () => false }), ["/in"], [])).refusal).toEqual({ reason: "verify-failed" });
    const stalled = new Error("stalled");
    expect(await checkRemoval(steps({ verify: async () => { throw stalled; } }), ["/in"], []))
      .toEqual({ refusal: { reason: "error", step: "verify", error: stalled }, verified: null });
    expect((await checkRemoval(steps({ inside: async () => { throw stalled; } }), ["/in"], [])).refusal)
      .toMatchObject({ reason: "error", step: "location" });
    // A later refusal still says the archive verified.
    expect(await checkRemoval(steps({ compare: async () => { throw stalled; } }), ["/in"], []))
      .toEqual({ refusal: { reason: "error", step: "recheck", error: stalled }, verified: { fingerprint: "f1" } });
  });

  it("refuses another file at the archive's path when told which file to expect", async () => {
    const ran: string[] = [];
    expect((await checkRemoval(steps({}, ran), ["/in"], [], "f0")).refusal).toEqual({ reason: "replaced" });
    expect(ran).toEqual(["state"]);
    expect((await checkRemoval(steps({ state: async () => ({ kind: "gone" }) }), ["/in"], [], "f1")).refusal).toEqual({ reason: "replaced" });
    expect((await checkRemoval(steps(), ["/in"], [], "f1")).refusal).toBeNull();
  });

  it("does not count as missing what came from an input already removed, unless another input shares its name", () => {
    const comparison = { matches: false, added: [], missing: ["b/x.txt", "a/y.txt"], changed: [], unlisted: [] };
    expect(explainRemoved(comparison, ["/one/a"], ["/two/b"])).toEqual({ ...comparison, missing: ["a/y.txt"], matches: false });
    expect(explainRemoved({ ...comparison, missing: ["b/x.txt"] }, ["/one/a"], ["/two/b"]).matches).toBe(true);
    expect(explainRemoved({ ...comparison, missing: ["a/x.txt"] }, ["/one/a"], ["/two/a"]).matches).toBe(false);
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
    const passed = await zip.checkRemoval({ inputs: [a, b] }, archive);
    expect(passed.refusal).toBeNull();
    const fingerprint = passed.verified!.fingerprint!;
    expect(fingerprint).toEqual(expect.any(String));
    // Only `a` is left to remove, `b` already went: its entries are expected.
    await rm(b, { recursive: true });
    expect((await zip.checkRemoval({ inputs: [a] }, archive, { removed: [b], fingerprint })).refusal).toBeNull();
    expect((await zip.checkRemoval({ inputs: [a] }, archive)).refusal).toMatchObject({ reason: "changed", comparison: { missing: ["b/2.txt"] } });
    await writeFile(path.join(a, "late.txt"), "late");
    expect((await zip.checkRemoval({ inputs: [a] }, archive, { removed: [b] })).refusal)
      .toMatchObject({ reason: "changed", comparison: { added: ["a/late.txt"] } });
    await rm(path.join(a, "late.txt"));
    // Damaged in place, the archive is still the one expected but cannot be read.
    await appendFile(archive, "trailing");
    expect((await zip.checkRemoval({ inputs: [a] }, archive, { removed: [b], fingerprint })).refusal)
      .toMatchObject({ reason: "error", step: "verify" });
    // Another file put in its place is not the one expected.
    // (Made while the first still exists, so it cannot reuse its inode.)
    const other = path.join(root, "other.zip");
    await zip.create({ inputs: [a], output: other });
    await rename(other, archive);
    expect((await zip.checkRemoval({ inputs: [a] }, archive, { removed: [b], fingerprint })).refusal).toEqual({ reason: "replaced" });
  });

  it("refuses an archive inside an input, and ignores how the spec would have named it", async () => {
    const root = await fixture();
    const input = path.join(root, "proj");
    await mkdir(input);
    await writeFile(path.join(input, "a.txt"), "a");
    const zip = new ZipKit();
    const archive = path.join(input, "proj.zip");
    await zip.create({ inputs: [input], output: archive });
    expect((await zip.checkRemoval({ inputs: [input], outputDir: root, outputName: "x" }, archive)).refusal).toEqual({ reason: "inside" });
  });
});
