import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appZipKit, createSdk } from "../../../src/gui/main/sdk.js";
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

  it("removes the originals only after checking them against the written archive, and classifies paths", async () => {
    const input = path.join(root, "docs");
    await mkdir(input);
    await writeFile(path.join(input, "note.txt"), "hello");
    const trashed: string[] = [];
    const sdk = createSdk(appZipKit(async (target) => { trashed.push(target); }));
    const plan = await sdk.plan([input], { ...DEFAULT_OPTIONS });
    await sdk.write(plan);
    const removal = await sdk.removeOriginals(plan.output, [input], [], { ...DEFAULT_OPTIONS }, "trash");
    expect(removal).toEqual({ refusal: null, verified: { fingerprint: expect.any(String) }, outcome: { moved: [input], gone: [], failed: [] } });
    expect(trashed).toEqual([input]);
    await writeFile(path.join(input, "late.txt"), "added after the archive");
    expect(await sdk.removeOriginals(plan.output, [input], [], { ...DEFAULT_OPTIONS }, "delete"))
      .toMatchObject({ refusal: { reason: "changed", comparison: { added: [path.join(input, "late.txt")] } }, outcome: null });
    const missing = await sdk.removeOriginals(path.join(root, "none.zip"), [input], [], { ...DEFAULT_OPTIONS }, "delete");
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

  it("deletes an original for good, and keeps one that could not go with its code for the log", async () => {
    const input = path.join(root, "folder");
    await mkdir(path.join(input, "nested"), { recursive: true });
    await writeFile(path.join(input, "nested", "a.txt"), "a");
    const sdk = createSdk(appZipKit(async () => { throw new Error("Trash unavailable"); }));
    const plan = await sdk.plan([input], { ...DEFAULT_OPTIONS });
    await sdk.write(plan);
    expect((await sdk.removeOriginals(plan.output, [input], [], { ...DEFAULT_OPTIONS }, "trash")).outcome)
      .toEqual({ moved: [], gone: [], failed: [{ path: input, message: "io.failed: Trash unavailable" }] });
    expect((await sdk.removeOriginals(plan.output, [input], [], { ...DEFAULT_OPTIONS }, "delete")).outcome)
      .toEqual({ moved: [input], gone: [], failed: [] });
    expect(await readdir(root)).toEqual(["folder.zip"]);
  });

  it("fails with the SDK's own error, which its guard recognizes", async () => {
    const sdk = createSdk();
    const failed = await sdk.plan([path.join(root, "missing")], { ...DEFAULT_OPTIONS }).catch((err: unknown) => err);
    expect(failed).toMatchObject({ code: "path.missing", kind: "unavailable", effect: "none" });
    expect(isZipKitError(failed)).toBe(true);
  });
});
