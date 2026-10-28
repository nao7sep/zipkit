import { mkdtemp, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSdk } from "../../../src/gui/main/sdk.js";
import { isZipKitError } from "zipkitsdk";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import type { LogEvent, ProgressCounts } from "../../../src/gui/shared/api.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "zipkit-sdk-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("the app's SDK verbs", () => {
  it("plans, writes and verifies a folder, with progress", async () => {
    const input = path.join(root, "photos");
    await mkdir(input);
    await writeFile(path.join(input, "a.txt"), "hello");
    const sdk = createSdk();
    const events: LogEvent[] = [];
    const plan = await sdk.plan([input], { ...DEFAULT_OPTIONS }, { onEvent: (e) => events.push(e) });
    expect(plan.writable).toBe(true);
    const counts: ProgressCounts[] = [];
    const bytes = await sdk.write(plan, { onProgress: (c) => counts.push(c) });
    expect(bytes).toBeGreaterThan(0);
    expect(counts.at(-1)).toEqual({ stage: "write", entriesDone: 1, entriesTotal: 1, bytesDone: 5, bytesTotal: 5 });
    expect(await sdk.verify(plan.output, "zipkit.json")).toBe(true);
    const report = await sdk.inspect(plan.output, "zipkit.json");
    expect(report).toEqual({ ok: true, summary: expect.objectContaining({ total: expect.any(Number) }), missing: [], extra: [] });
    expect(report).not.toHaveProperty("entries");
    expect(events.some((e) => e.event === "plan.done")).toBe(true);
    expect((await readdir(root)).sort()).toEqual(["photos", "photos.zip"]);
  });

  it("checks the originals against the written archive before removal, and classifies paths", async () => {
    const input = path.join(root, "docs");
    await mkdir(input);
    await writeFile(path.join(input, "note.txt"), "hello");
    const sdk = createSdk();
    const plan = await sdk.plan([input], { ...DEFAULT_OPTIONS });
    await sdk.write(plan);
    const check = await sdk.checkRemoval(plan.output, [input], [], { ...DEFAULT_OPTIONS });
    expect(check).toEqual({ refusal: null, verified: { fingerprint: expect.any(String) } });
    await writeFile(path.join(input, "late.txt"), "added after the archive");
    expect((await sdk.checkRemoval(plan.output, [input], [], { ...DEFAULT_OPTIONS })).refusal)
      .toMatchObject({ reason: "changed", comparison: { added: [path.join(input, "late.txt")] } });
    const missing = await sdk.checkRemoval(path.join(root, "none.zip"), [input], [], { ...DEFAULT_OPTIONS });
    expect(missing.refusal).toMatchObject({ reason: "error", step: "verify", error: { name: expect.any(String), message: expect.any(String) } });
    expect(await sdk.pathKinds([input, path.join(root, "gone")])).toEqual([
      { path: input, kind: "directory" },
      { path: path.join(root, "gone"), kind: "missing" },
    ]);
  });

  it("tells what is at a path: there with a fingerprint that changes with its content, or gone", async () => {
    const archive = path.join(root, "a.zip");
    await writeFile(archive, "first");
    const sdk = createSdk();
    const first = await sdk.pathState(archive);
    expect(first).toEqual({ kind: "present", fingerprint: expect.any(String) });
    expect(await sdk.pathState(archive)).toEqual(first);
    await writeFile(archive, "a longer second version");
    expect(await sdk.pathState(archive)).not.toEqual(first);
    await rm(archive);
    expect(await sdk.pathState(archive)).toEqual({ kind: "missing" });
  });

  it("deletes an original for good: a folder with its contents, or a link itself rather than its target", async () => {
    const folder = path.join(root, "folder");
    await mkdir(path.join(folder, "nested"), { recursive: true });
    await writeFile(path.join(folder, "nested", "a.txt"), "a");
    const target = path.join(root, "target.txt");
    await writeFile(target, "kept");
    const link = path.join(root, "link");
    await symlink(target, link);
    const sdk = createSdk();
    await sdk.deletePath(folder);
    await sdk.deletePath(link);
    expect((await readdir(root)).sort()).toEqual(["target.txt"]);
    // The errno code says an original was already gone rather than that its deletion failed.
    await expect(sdk.deletePath(path.join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT", message: expect.stringContaining("ENOENT") });
  });

  it("fails with the SDK's own error, which its guard recognizes", async () => {
    const sdk = createSdk();
    const failed = await sdk.plan([path.join(root, "missing")], { ...DEFAULT_OPTIONS }).catch((err: unknown) => err);
    expect(failed).toMatchObject({ code: "path.missing", kind: "unavailable", effect: "none" });
    expect(isZipKitError(failed)).toBe(true);
  });
});
