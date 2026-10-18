import { mkdtemp, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSdkClient, type HostProcess } from "../../../src/gui/main/sdk-client.js";
import { createSdkHost, type HostReply, type HostRequest } from "../../../src/gui/main/sdk-host.js";
import { exportPlan, importPlan } from "zipkitsdk";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import type { LogEvent, ProgressCounts } from "../../../src/gui/shared/api.js";

/** The host served over a channel that copies every message as a process
 *  boundary does, so what survives the copy is what the app relies on. */
function inProcessHost(): HostProcess {
  let deliver: (reply: HostReply) => void = () => {};
  const host = createSdkHost((reply) => queueMicrotask(() => deliver(structuredClone(reply))));
  return {
    postMessage: (request: HostRequest) => queueMicrotask(() => host.handle(structuredClone(request))),
    onMessage: (listener) => { deliver = listener; },
    onExit: () => {},
    kill: () => {},
  };
}

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "zipkit-sdk-host-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("the SDK host", () => {
  it("plans, writes and verifies a folder across a copied channel, with progress", async () => {
    const input = path.join(root, "photos");
    await mkdir(input);
    await writeFile(path.join(input, "a.txt"), "hello");
    const sdk = createSdkClient(inProcessHost);
    const events: LogEvent[] = [];
    // The plan crosses packaged by exportPlan; importPlan makes it writable again.
    const plan = importPlan(await sdk.call("plan", [[input], { ...DEFAULT_OPTIONS }], { onEvent: (e) => events.push(e) }));
    expect(plan.writable).toBe(true);
    const settlements: Promise<void>[] = [];
    const counts: ProgressCounts[] = [];
    const bytes = await sdk.call("write", [exportPlan(plan)], {
      onPhysicalSettlement: (p) => settlements.push(p),
      onProgress: (c) => counts.push(c),
    });
    expect(bytes).toBeGreaterThan(0);
    // How far the write got crosses too, to its last byte.
    expect(counts.at(-1)).toEqual({ stage: "write", entriesDone: 1, entriesTotal: 1, bytesDone: 5, bytesTotal: 5 });
    await Promise.all(settlements);
    expect(await sdk.call("verify", [plan.output, true])).toBe(true);
    const report = await sdk.call("inspect", [plan.output, true]);
    expect(report).toEqual({ reportOk: true, summary: expect.objectContaining({ total: expect.any(Number) }), missing: [], extra: [] });
    expect(report).not.toHaveProperty("entries");
    expect(events.some((e) => e.event === "plan.done")).toBe(true);
    expect((await readdir(root)).sort()).toEqual(["photos", "photos.zip"]);
  });

  it("checks the originals against the written archive before removal, and classifies and resolves paths", async () => {
    const input = path.join(root, "docs");
    await mkdir(input);
    await writeFile(path.join(input, "note.txt"), "hello");
    const sdk = createSdkClient(inProcessHost);
    const transfer = await sdk.call("plan", [[input], { ...DEFAULT_OPTIONS }]);
    const plan = transfer.plan;
    await sdk.call("write", [transfer]);
    const check = await sdk.call("checkRemoval", [plan.output, [input], [], { ...DEFAULT_OPTIONS }]);
    expect(check).toEqual({ refusal: null, verified: { fingerprint: expect.any(String) } });
    await writeFile(path.join(input, "late.txt"), "added after the archive");
    expect((await sdk.call("checkRemoval", [plan.output, [input], [], { ...DEFAULT_OPTIONS }])).refusal)
      .toMatchObject({ reason: "changed", comparison: { added: ["docs/late.txt"] } });
    // An error crosses as the fields main reads.
    const missing = await sdk.call("checkRemoval", [path.join(root, "none.zip"), [input], [], { ...DEFAULT_OPTIONS }]);
    expect(missing.refusal).toMatchObject({ reason: "error", step: "location", error: { name: expect.any(String), message: expect.any(String) } });
    expect(await sdk.call("classify", [[input, path.join(root, "gone")]])).toEqual([
      { path: input, kind: "directory" },
      { path: path.join(root, "gone"), kind: "missing" },
    ]);
    const [resource] = await sdk.call("resources", [[plan.output]]);
    expect(resource).toMatchObject({ location: expect.stringContaining("docs.zip"), identity: expect.any(String) });
  });

  it("tells what is at a path: there with a fingerprint that changes with its content, or gone", async () => {
    const archive = path.join(root, "a.zip");
    await writeFile(archive, "first");
    const sdk = createSdkClient(inProcessHost);
    const first = await sdk.call("pathState", [archive]);
    expect(first).toEqual({ kind: "present", fingerprint: expect.any(String) });
    expect(await sdk.call("pathState", [archive])).toEqual(first);
    await writeFile(archive, "a longer second version");
    expect(await sdk.call("pathState", [archive])).not.toEqual(first);
    await rm(archive);
    expect(await sdk.call("pathState", [archive])).toEqual({ kind: "gone" });
  });

  it("deletes an original for good: a folder with its contents, or a link itself rather than its target", async () => {
    const folder = path.join(root, "folder");
    await mkdir(path.join(folder, "nested"), { recursive: true });
    await writeFile(path.join(folder, "nested", "a.txt"), "a");
    const target = path.join(root, "target.txt");
    await writeFile(target, "kept");
    const link = path.join(root, "link");
    await symlink(target, link);
    const sdk = createSdkClient(inProcessHost);
    await sdk.call("deletePath", [folder]);
    await sdk.call("deletePath", [link]);
    expect((await readdir(root)).sort()).toEqual(["target.txt"]);
    await expect(sdk.call("deletePath", [path.join(root, "missing")])).rejects.toMatchObject({ message: expect.stringContaining("ENOENT") });
  });

  it("carries an SDK failure's type, code and path back to main", async () => {
    const sdk = createSdkClient(inProcessHost);
    await expect(sdk.call("plan", [[path.join(root, "missing")], { ...DEFAULT_OPTIONS }])).rejects.toMatchObject({
      errorType: "scan",
      code: "scan.input-missing",
    });
  });

  it("cancels a running call when main asks", async () => {
    const replies: HostReply[] = [];
    const host = createSdkHost((reply) => replies.push(reply));
    const input = path.join(root, "many");
    await mkdir(input);
    await Promise.all(Array.from({ length: 200 }, (_, i) => writeFile(path.join(input, `f${i}`), "x")));
    host.handle({ type: "call", id: 7, op: "plan", args: [[input], { ...DEFAULT_OPTIONS }] });
    host.handle({ type: "cancel", id: 7 });
    await vi.waitFor(() => expect(replies.some((r) => r.type === "failed" || r.type === "done")).toBe(true));
    expect(replies.find((r) => r.id === 7 && r.type !== "event")).toMatchObject({ type: "failed", error: { errorType: "abort" } });
  });
});
