import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZipKit } from "../../src/index.ts";
import { readInternals } from "../../src/internal/carrier.ts";
import { planArchive } from "../../src/plan/plan.ts";
import { resolvePolicy } from "../../src/policy.ts";
import { buildMetadata, manifestText } from "../../src/write/metadata.ts";
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
function document(plan: ReturnType<typeof planArchive>) {
  return buildMetadata(plan, policy, readInternals(plan)!.writeEntries.map((writeEntry) => ({
    writeEntry, crc32: 0, compressedSize: 0,
  })), Y2020_NS, "UTC");
}

describe("manifests of any size", () => {
  it("round-trips a large folder whose manifest exceeds the former 16 MiB reader cap", async () => {
    const plan = planArchive(scanResult(directories(25_000), { output: path.join(root, "large.zip") }), policy);
    expect(plan.writable).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(document(plan), null, 2))).toBeGreaterThan(16 * 1024 * 1024);
    await write(plan);
    const verified = await new ZipKit().extract({ archive: plan.output, dryRun: true, checkMetadata: true });
    expect(verified.reportOk).toBe(true);
    expect(verified.entries).toHaveLength(25_001);
  }, 15_000); // 25,000 real ZIP directory writes, under ordinary suite concurrency

  it("writes the manifest in pieces that join into exactly its JSON text", () => {
    const entries = Array.from({ length: 65_535 }, (_, i) => scanEntry({
      archivePath: `project/src/components/entry-${String(i).padStart(5, "0")}.ts`, size: 1024,
    }));
    const plan = planArchive(scanResult(entries), policy);
    const metadata = buildMetadata(plan, policy, readInternals(plan)!.writeEntries.map((writeEntry) => ({
      writeEntry, crc32: 0xffffffff, compressedSize: 512, sha256: "a".repeat(64),
    })), Y2020_NS, "UTC", "a comment");
    expect([...manifestText(metadata)].join("")).toBe(JSON.stringify(metadata, null, 2));
    const empty = buildMetadata(planArchive(scanResult([]), policy), policy, [], Y2020_NS, "UTC");
    expect([...manifestText(empty)].join("")).toBe(JSON.stringify(empty, null, 2));
  });


  it("writes and verifies a manifest past the former 64 MiB limit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Number(Y2020_NS / 1_000_000n)));
    const output = path.join(root, "past-limit.zip");
    const plan = planArchive(scanResult(directories(1), { output }), policy);
    // One long finding message carries the manifest past the old limit cheaply.
    plan.findings.push({ rule: "name.suspicious", severity: "warning", path: "folder-0", message: "é".repeat(33 * 1024 * 1024) });
    await write(plan);
    const verified = await new ZipKit().extract({ archive: output, dryRun: true, checkMetadata: true });
    expect(verified.reportOk).toBe(true);
    expect(await readdir(root)).toEqual(["past-limit.zip"]);
  }, 15_000); // a 66 MiB manifest deflated and inflated once each

});
