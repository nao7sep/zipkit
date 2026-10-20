import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZipKit } from "../../src/index.ts";
import { fromInstructions } from "../../src/internal/instructions.ts";
import { planArchive } from "../../src/plan/plan.ts";
import { resolvePolicy } from "../../src/policy.ts";
import { buildManifest, manifestText } from "../../src/write/manifest.ts";
import { writeArchive } from "../../src/write/write.ts";
import { createLogger } from "../../src/log/logger.ts";
import { scanEntry, scanResult, Y2020_NS } from "../helpers/synthetic.ts";
import { realVolume } from "../helpers/volume.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "zipkit-manifest-budget-")); });
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });
const policy = resolvePolicy(undefined, { emptyDirs: "keep" });
function directories(count: number) {
  return Array.from({ length: count }, (_, i) => scanEntry({ archivePath: `folder-${i}`, type: "dir", size: 0, mode: 0o40755 }));
}
const write = (plan: ReturnType<typeof planArchive>) => writeArchive(plan, {
  logger: createLogger(), chunkSize: 65536, volume: realVolume(),
});

describe("manifests of any size", () => {
  it("round-trips a folder of many entries, every record read back", async () => {
    const plan = planArchive(scanResult(directories(2_000), { output: path.join(root, "many.zip") }), policy);
    expect(plan.writable).toBe(true);
    await write(plan);
    const verified = await new ZipKit().verify({ archive: plan.output, manifest: true });
    expect(verified.ok).toBe(true);
    expect(verified.entries).toHaveLength(2_001);
  });

  it("writes the manifest in pieces that join into exactly its JSON text", () => {
    const entries = Array.from({ length: 2_000 }, (_, i) => scanEntry({
      archivePath: `project/src/components/entry-${String(i).padStart(5, "0")}.ts`, size: 1024,
    }));
    const plan = planArchive(scanResult(entries), policy);
    const metadata = buildManifest(plan, policy, fromInstructions(plan.instructions)!.writeEntries.map((writeEntry) => ({
      writeEntry, crc32: 0xffffffff, compressedSize: 512, sha256: "a".repeat(64),
    })), { createdNs: Y2020_NS, timeZone: "UTC", comment: "a comment" });
    expect([...manifestText(metadata)].join("")).toBe(JSON.stringify(metadata, null, 2));
    const empty = buildManifest(planArchive(scanResult([]), policy), policy, [], { createdNs: Y2020_NS, timeZone: "UTC" });
    expect([...manifestText(empty)].join("")).toBe(JSON.stringify(empty, null, 2));
  });


  it("writes and verifies a manifest past the former 64 MiB limit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Number(Y2020_NS / 1_000_000n)));
    const output = path.join(root, "past-limit.zip");
    const plan = planArchive(scanResult(directories(1), { output }), policy);
    // One long finding message carries the manifest past the old limit cheaply.
    plan.findings.push({ id: "name.suspicious:folder-0", rule: "name.suspicious", severity: "warning", path: "folder-0", message: "é".repeat(33 * 1024 * 1024) });
    await write(plan);
    const verified = await new ZipKit().verify({ archive: output, manifest: true });
    expect(verified.ok).toBe(true);
    expect(await readdir(root)).toEqual(["past-limit.zip"]);
  }, 15_000); // a 66 MiB manifest deflated and inflated once each

});
