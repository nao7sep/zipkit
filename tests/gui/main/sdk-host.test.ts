import { mkdtemp, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSdkClient, type HostProcess } from "../../../src/gui/main/sdk-client.js";
import { createSdkHost, type HostReply, type HostRequest } from "../../../src/gui/main/sdk-host.js";
import { isZipKitError, ZipKit, type PlanData } from "zipkitsdk";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import type { LogEvent, ProgressCounts } from "../../../src/gui/shared/api.js";

/** The host served over a channel that copies every message as a process
 *  boundary does, so what survives the copy is what the app relies on. */
function inProcessHost(zip?: ZipKit): HostProcess {
  let deliver: (reply: HostReply) => void = () => {};
  const host = createSdkHost((reply) => queueMicrotask(() => deliver(structuredClone(reply))), zip);
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
    const plan = await sdk.call("plan", [[input], { ...DEFAULT_OPTIONS }, "job"], { onEvent: (e) => events.push(e) });
    expect(plan.writable).toBe(true);
    expect(plan).not.toHaveProperty("entries");
    expect(plan).not.toHaveProperty("instructions");
    expect(await sdk.call("report", [plan.revision])).toMatchObject({ writable: true, entries: [] });
    const settlements: Promise<void>[] = [];
    const counts: ProgressCounts[] = [];
    const bytes = await sdk.call("write", [plan], {
      onPhysicalSettlement: (p) => settlements.push(p),
      onProgress: (c) => counts.push(c),
    });
    expect(bytes).toBeGreaterThan(0);
    // How far the write got crosses too, to its last byte.
    expect(counts.at(-1)).toEqual({ stage: "write", entriesDone: 1, entriesTotal: 1, bytesDone: 5, bytesTotal: 5 });
    await Promise.all(settlements);
    expect(await sdk.call("verify", [plan.output, "zipkit.json"])).toBe(true);
    const report = await sdk.call("inspect", [plan.output, "zipkit.json"]);
    expect(report).toEqual({ ok: true, summary: expect.objectContaining({ total: expect.any(Number) }), missing: [], extra: [] });
    expect(report).not.toHaveProperty("entries");
    expect(events.some((e) => e.event === "plan.done")).toBe(true);
    expect((await readdir(root)).sort()).toEqual(["photos", "photos.zip"]);
  });

  it("checks the originals against the written archive before removal, and classifies and resolves paths", async () => {
    const input = path.join(root, "docs");
    await mkdir(input);
    await writeFile(path.join(input, "note.txt"), "hello");
    const sdk = createSdkClient(inProcessHost);
    const plan = await sdk.call("plan", [[input], { ...DEFAULT_OPTIONS }, "job"]);
    await sdk.call("write", [plan]);
    const check = await sdk.call("checkRemoval", [plan.output, [input], [], { ...DEFAULT_OPTIONS }]);
    expect(check).toEqual({ refusal: null, verified: { fingerprint: expect.any(String) } });
    await writeFile(path.join(input, "late.txt"), "added after the archive");
    expect((await sdk.call("checkRemoval", [plan.output, [input], [], { ...DEFAULT_OPTIONS }])).refusal)
      .toMatchObject({ reason: "changed", comparison: { added: [path.join(input, "late.txt")] } });
    // An error crosses as the fields main reads.
    const missing = await sdk.call("checkRemoval", [path.join(root, "none.zip"), [input], [], { ...DEFAULT_OPTIONS }]);
    expect(missing.refusal).toMatchObject({ reason: "error", step: "verify", error: { name: expect.any(String), message: expect.any(String) } });
    expect(await sdk.call("pathKinds", [[input, path.join(root, "gone")]])).toEqual([
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
    expect(await sdk.call("pathState", [archive])).toEqual({ kind: "missing" });
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
    // The errno code crosses too, so main tells an original already gone from a deletion that failed.
    await expect(sdk.call("deletePath", [path.join(root, "missing")])).rejects.toMatchObject({ code: "ENOENT", message: expect.stringContaining("ENOENT") });
  });

  it("carries an SDK failure back to main as the SDK's own data, which its guard still recognizes", async () => {
    const sdk = createSdkClient(inProcessHost);
    const failed = await sdk.call("plan", [[path.join(root, "missing")], { ...DEFAULT_OPTIONS }, "job"]).catch((err: unknown) => err);
    expect(failed).toMatchObject({ code: "path.missing", kind: "unavailable", effect: "none" });
    expect(isZipKitError(failed)).toBe(true);
  });

  it("cancels a running call when main asks", async () => {
    const replies: HostReply[] = [];
    const host = createSdkHost((reply) => replies.push(reply));
    const input = path.join(root, "many");
    await mkdir(input);
    await Promise.all(Array.from({ length: 200 }, (_, i) => writeFile(path.join(input, `f${i}`), "x")));
    host.handle({ type: "call", id: 7, op: "plan", args: [[input], { ...DEFAULT_OPTIONS }, "job"] });
    host.handle({ type: "cancel", id: 7 });
    await vi.waitFor(() => expect(replies.some((r) => r.type === "failed" || r.type === "done")).toBe(true));
    expect(replies.find((r) => r.id === 7 && r.type !== "event")).toMatchObject({ type: "failed", error: { code: "operation.cancelled", kind: "cancelled" } });
  });

  it("keeps the public SDK's transferable PlanData contract independent of GUI references", async () => {
    const input = path.join(root, "public.txt");
    await writeFile(input, "public SDK data");
    const zip = new ZipKit();
    const plan: PlanData = JSON.parse(JSON.stringify(await zip.plan({ inputs: [input], output: path.join(root, "public.zip") })));
    expect(plan.entries).toHaveLength(1);
    expect(plan.instructions.entries).toHaveLength(1);
    const original = structuredClone(plan);
    const sdk = createSdkClient(inProcessHost);
    const reference = await sdk.call("plan", [[input], { ...DEFAULT_OPTIONS }, "gui"]);
    await sdk.call("forgetPlan", ["gui"]);
    expect(reference).not.toHaveProperty("instructions");
    expect(plan).toEqual(original);
    expect(await zip.write(plan)).toMatchObject({ mode: "write" });
    expect((await zip.verify({ archive: plan.output, manifest: true })).ok).toBe(true);
  });

  it("projects report entries on demand and detects changed paths with the same summary", async () => {
    const input = path.join(root, "review");
    await mkdir(input);
    await writeFile(path.join(input, "a.txt"), "same size");
    await writeFile(path.join(input, ".DS_Store"), "excluded");
    const sdk = createSdkClient(inProcessHost);
    const first = await sdk.call("plan", [[input], { ...DEFAULT_OPTIONS }, "review-job"]);
    const report = await sdk.call("report", [first.revision]);
    expect(report.entries.map((entry) => entry.archivePath)).toEqual([".DS_Store"]);
    expect(report).not.toHaveProperty("instructions");
    const unchanged = await sdk.call("plan", [[input], { ...DEFAULT_OPTIONS }, "review-job", first.revision]);
    expect(unchanged.reviewChanged).toBe(false);
    await rm(path.join(input, "a.txt"));
    await writeFile(path.join(input, "b.txt"), "same size");
    const changed = await sdk.call("plan", [[input], { ...DEFAULT_OPTIONS }, "review-job", unchanged.revision]);
    expect(changed.summary).toEqual(unchanged.summary);
    expect(changed.reviewChanged).toBe(true);
    expect(changed).not.toHaveProperty("entries");
    expect(changed).not.toHaveProperty("instructions");
  });

  it.each(["forgetPlan", "new host"] as const)("refuses report and write for a reference invalidated by %s", async (invalidate) => {
    const input = path.join(root, "stale.txt");
    await writeFile(input, "original");
    let sdk = createSdkClient(inProcessHost);
    const reference = await sdk.call("plan", [[input], { ...DEFAULT_OPTIONS }, "stale-job"]);
    if (invalidate === "forgetPlan") await sdk.call("forgetPlan", ["stale-job"]);
    else sdk = createSdkClient(inProcessHost);
    await expect(sdk.call("report", [reference.revision])).rejects.toMatchObject({ message: expect.stringContaining("no longer available") });
    await expect(sdk.call("write", [reference])).rejects.toMatchObject({ message: expect.stringContaining("no longer available") });
    expect(await readdir(root)).toEqual(["stale.txt"]);
  });

  it.each(["superseded", "cancelled"] as const)("prevents a %s plan completing late from replacing the host cache", async (ending) => {
    const inputs = [path.join(root, "first.txt"), path.join(root, "late.txt"), path.join(root, "newest.txt")];
    await Promise.all(inputs.map((input) => writeFile(input, "payload")));
    const zip = new ZipKit();
    const lateData = await zip.plan({ inputs: [inputs[1]!], output: path.join(root, "late.zip") });
    const sdk = createSdkClient(() => inProcessHost(zip));
    const first = await sdk.call("plan", [[inputs[0]!], { ...DEFAULT_OPTIONS }, "same-owner"]);
    let release!: (plan: PlanData) => void;
    const held = new Promise<PlanData>((resolve) => { release = resolve; });
    const planSpy = vi.spyOn(zip, "plan").mockImplementationOnce(() => held);
    try {
      const controller = new AbortController();
      const pending = sdk.call("plan", [[inputs[1]!], { ...DEFAULT_OPTIONS }, "same-owner", first.revision], { signal: controller.signal });
      const rejected = expect(pending).rejects.toMatchObject({ code: "operation.cancelled" });
      await vi.waitFor(() => expect(planSpy).toHaveBeenCalledOnce());
      let current = first;
      if (ending === "superseded") current = await sdk.call("plan", [[inputs[2]!], { ...DEFAULT_OPTIONS }, "same-owner", first.revision]);
      else controller.abort();
      release(lateData);
      await rejected;
      expect(await sdk.call("report", [current.revision])).toMatchObject({ writable: true });
      expect(await sdk.call("write", [current])).toBeGreaterThan(0);
      expect(await sdk.call("verify", [current.output, "zipkit.json"])).toBe(true);
      expect(await readdir(root)).not.toContain("late.zip");
    } finally {
      planSpy.mockRestore();
    }
  });
});

it("retains origin diagnostics across the host error boundary without custom payloads", async () => {
  const { ZipKitError } = await import("zipkitsdk");
  const { failure } = await import("../../../src/gui/main/sdk-host.js");
  const { SdkHostError } = await import("../../../src/gui/main/sdk-client.js");
  const origin = Object.assign(new Error("read failed"), { code: "EIO", errno: -5, syscall: "read", path: "/input/a", privatePayload: "PRIVATE_PAYLOAD_SENTINEL" });
  origin.stack = "Error: read failed\n    at originatingRead (/input.ts:9:2)";
  const data = structuredClone(failure(new ZipKitError("io.failed", "unable to read", { cause: origin })));
  const received = new SdkHostError(data);
  expect(received.stack).toBe(data.stack);
  expect(received.cause).toEqual({ name: "Error", message: "read failed", stack: origin.stack, code: "EIO", errno: -5, syscall: "read", path: "/input/a" });
  expect(JSON.stringify(data)).not.toContain("PRIVATE_PAYLOAD_SENTINEL");
  const raw = new SdkHostError(structuredClone(failure(origin)));
  expect(raw).toMatchObject({ stack: origin.stack, code: "EIO", errno: -5, syscall: "read", path: "/input/a" });
});
