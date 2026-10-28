/**
 * Removing the originals, and the checks before: the archive must not sit
 * inside an input (removing the input would take the archive with it), must
 * verify, and the inputs must still match it. A bug here risks the user's only
 * copy, so the boundary cases, the order of the checks and what becomes of
 * each original are pinned.
 */

import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { checkRemoval, outputInsideInputs as check, removeInTurn, type RemovalSteps } from "../src/removal.ts";
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
    const failed = new ZipKitError("io.failed", "read failed", { subject: "/out/a.zip" });
    expect(await check(steps({ verify: async () => { throw failed; } })))
      .toEqual({ refusal: { reason: "error", step: "verify", error: failed.toJSON() }, verified: null });
    // A raw file-system failure arrives classified, naming the archive.
    const missing = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    expect((await check(steps({ inside: async () => { throw missing; } }))).refusal)
      .toMatchObject({ reason: "error", step: "location", error: { code: "path.missing", kind: "unavailable", subject: "/out/a.zip" } });
    // A later refusal still says the archive verified.
    expect(await check(steps({ compare: async () => { throw failed; } })))
      .toEqual({ refusal: { reason: "error", step: "recheck", error: failed.toJSON() }, verified: { fingerprint: "f1" } });
    // The refusal is plain data, so it crosses a process boundary as it is.
    const { refusal } = await check(steps({ compare: async () => { throw failed; } }));
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

/** A Trash that records what it was given and keeps it, so the checks can run again. */
function keepingTrash(): { trashed: string[]; zip: ZipKit } {
  const trashed: string[] = [];
  return { trashed, zip: new ZipKit({ trash: async (target) => { trashed.push(target); } }) };
}

describe("removeInTurn", () => {
  it("removes each path in turn, says which were already gone, and keeps what failed with its code", async () => {
    const outcome = await removeInTurn(["/a", "/b", "/c"], {
      remove: async (target) => {
        if (target === "/b") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        if (target === "/c") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      gone: async (_target, error) => (error as { code?: unknown }).code === "ENOENT",
    });
    expect(outcome).toMatchObject({ removed: ["/a"], gone: ["/b"], kept: [{ path: "/c", error: { code: "path.denied", subject: "/c" } }] });
    // A host's Trash failing without an errno is the disk's failure, not the SDK's.
    const trash = await removeInTurn(["/a"], { remove: async () => { throw new Error("could not move"); }, gone: async () => false });
    expect(trash.kept).toMatchObject([{ path: "/a", error: { code: "io.failed", kind: "unavailable" } }]);
  });

  it("lets a call already running end, and keeps every path after a cancel", async () => {
    const controller = new AbortController();
    const removed: string[] = [];
    const outcome = await removeInTurn(["/a", "/b", "/c"], {
      remove: async (target) => { removed.push(target); controller.abort(); },
      gone: async () => false,
    }, controller.signal);
    expect(removed).toEqual(["/a"]);
    expect(outcome).toMatchObject({ removed: ["/a"], gone: [], kept: [{ path: "/b", error: { code: "operation.cancelled" } }, { path: "/c", error: { code: "operation.cancelled" } }] });
  });
});

describe("ZipKit.removeOriginals", () => {
  it("passes a fresh archive, then refuses once the originals change or the archive is altered", async () => {
    const root = await fixture();
    const a = path.join(root, "a"), b = path.join(root, "b");
    await mkdir(a); await mkdir(b);
    await writeFile(path.join(a, "1.txt"), "one"); await writeFile(path.join(b, "2.txt"), "two");
    const { trashed, zip } = keepingTrash();
    const archive = path.join(root, "out.zip");
    await zip.create({ inputs: [a, b], output: archive });
    const passed = await zip.removeOriginals({ spec: { inputs: [a, b] }, archive, method: "trash" });
    expect(passed.refusal).toBeNull();
    expect(passed.verified?.fingerprint).toEqual(expect.any(String));
    expect(passed.outcome).toEqual({ removed: [a, b], gone: [], kept: [] });
    expect(trashed).toEqual([a, b]);
    // Only `a` is left to remove, `b` already went: its entries are expected.
    await rm(b, { recursive: true });
    expect((await zip.removeOriginals({ spec: { inputs: [a] }, archive, removed: [b], method: "trash" })).refusal).toBeNull();
    const changed = await zip.removeOriginals({ spec: { inputs: [a] }, archive, method: "trash" });
    expect(changed).toMatchObject({ refusal: { reason: "changed", comparison: { missing: ["b/2.txt"] } }, outcome: null });
    await writeFile(path.join(a, "late.txt"), "late");
    expect((await zip.removeOriginals({ spec: { inputs: [a] }, archive, removed: [b], method: "trash" })).refusal)
      .toMatchObject({ reason: "changed", comparison: { added: [path.join(a, "late.txt")] } });
    await rm(path.join(a, "late.txt"));
    // Damaged, the archive can no longer be read.
    await appendFile(archive, "trailing");
    expect((await zip.removeOriginals({ spec: { inputs: [a] }, archive, removed: [b], method: "trash" })).refusal)
      .toMatchObject({ reason: "error", step: "verify", error: { kind: "invalid" } });
    expect(trashed).toEqual([a, b, a]);
  });

  it("verifies against a manifest made under another name, refuses relative inputs, and throws when cancelled", async () => {
    const root = await fixture();
    const input = path.join(root, "proj");
    await mkdir(input);
    await writeFile(path.join(input, "a.txt"), "a");
    const { zip } = keepingTrash();
    const archive = path.join(root, "proj.zip");
    const policy = { manifest: { name: "files.json" } };
    await zip.create({ inputs: [input], output: archive, policy });
    expect((await zip.removeOriginals({ spec: { inputs: [input], policy }, archive, method: "trash" })).refusal).toBeNull();
    await expect(zip.removeOriginals({ spec: { inputs: ["proj"] }, archive, method: "trash" })).rejects.toMatchObject({ kind: "invalid" });
    const controller = new AbortController();
    controller.abort();
    await expect(zip.removeOriginals({ spec: { inputs: [input] }, archive, method: "delete" }, { signal: controller.signal })).rejects.toMatchObject({ code: "operation.cancelled", kind: "cancelled" });
    expect(await readdir(input)).toEqual(["a.txt"]);
  });

  it("refuses an archive inside an input, and ignores how the spec would have named it", async () => {
    const root = await fixture();
    const input = path.join(root, "proj");
    await mkdir(input);
    await writeFile(path.join(input, "a.txt"), "a");
    const zip = new ZipKit();
    const archive = path.join(input, "proj.zip");
    await zip.create({ inputs: [input], output: archive });
    expect(await zip.removeOriginals({ spec: { inputs: [input], outputDir: root, outputName: "x" }, archive, method: "delete" }))
      .toEqual({ refusal: { reason: "inside" }, verified: null, outcome: null });
  });

  it.runIf(fileSymlinksSupported)("deletes the originals for good: a folder with its contents, or a link itself rather than its target", async () => {
    const root = await fixture();
    const folder = path.join(root, "folder");
    await mkdir(path.join(folder, "nested"), { recursive: true });
    await writeFile(path.join(folder, "nested", "a.txt"), "a");
    const target = path.join(root, "target.txt");
    await writeFile(target, "kept");
    const link = path.join(root, "link");
    await createFileLink(target, link);
    const zip = new ZipKit();
    const archive = path.join(root, "out.zip");
    await zip.create({ inputs: [folder, link], output: archive });
    const result = await zip.removeOriginals({ spec: { inputs: [folder, link] }, archive, method: "delete" });
    expect(result).toMatchObject({ refusal: null, outcome: { removed: [folder, link], gone: [], kept: [] } });
    expect((await readdir(root)).sort()).toEqual(["out.zip", "target.txt"]);
  });

  it("says an original was already gone when the host's Trash failed because something else took it", async () => {
    const root = await fixture();
    const a = path.join(root, "a"), b = path.join(root, "b");
    await mkdir(a); await mkdir(b);
    await writeFile(path.join(a, "1.txt"), "one"); await writeFile(path.join(b, "2.txt"), "two");
    const zip = new ZipKit({
      trash: async (target) => {
        if (target === a) { await rm(a, { recursive: true }); throw new Error("not found"); }
        throw new Error("Trash refused");
      },
    });
    const archive = path.join(root, "out.zip");
    await zip.create({ inputs: [a, b], output: archive });
    const { outcome } = await zip.removeOriginals({ spec: { inputs: [a, b] }, archive, method: "trash" });
    expect(outcome).toMatchObject({ removed: [], gone: [a], kept: [{ path: b, error: { code: "io.failed" } }] });
  });
});
