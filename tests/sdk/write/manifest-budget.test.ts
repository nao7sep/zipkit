import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZipKit } from "../../../src/sdk/index.js";
import { readInternals } from "../../../src/sdk/internal/carrier.js";
import { planArchive } from "../../../src/sdk/plan/plan.js";
import { resolvePolicy } from "../../../src/sdk/policy.js";
import { buildMetadata, MAX_MANIFEST_BYTES } from "../../../src/sdk/write/metadata.js";
import { writeArchive } from "../../../src/sdk/write/write.js";
import { createLogger } from "../../../src/sdk/log/logger.js";
import { scanEntry, scanResult, Y2020_NS } from "../../helpers/synthetic.js";
import { realVolume } from "../../helpers/volume.js";

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

describe("the shared manifest byte budget", () => {
  it("round-trips a large folder whose manifest exceeds the former 16 MiB reader cap", async () => {
    const plan = planArchive(scanResult(directories(25_000), { output: path.join(root, "large.zip") }), policy);
    expect(plan.writable).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(document(plan), null, 2))).toBeGreaterThan(16 * 1024 * 1024);
    await write(plan);
    const verified = await new ZipKit().extract({ archive: plan.output, dryRun: true, checkMetadata: true });
    expect(verified.reportOk).toBe(true);
    expect(verified.entries).toHaveLength(25_001);
  }, 15_000); // 25,000 real ZIP directory writes, under ordinary suite concurrency

  it("supports representative metadata at the ZIP64 entry-count boundary", () => {
    const entries = Array.from({ length: 65_535 }, (_, i) => scanEntry({
      archivePath: `project/src/components/entry-${String(i).padStart(5, "0")}.ts`, size: 1024,
    }));
    const plan = planArchive(scanResult(entries), policy);
    expect(plan.summary.zip64).toBe(true);
    const metadata = buildMetadata(plan, policy, readInternals(plan)!.writeEntries.map((writeEntry) => ({
      writeEntry, crc32: 0xffffffff, compressedSize: 512, sha256: "a".repeat(64),
    })), Y2020_NS, "UTC");
    expect(Buffer.byteLength(JSON.stringify(metadata, null, 2))).toBeLessThan(MAX_MANIFEST_BYTES);
  });

  it("admits exact UTF-8 bytes and refuses one byte more before replacing an existing archive", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Number(Y2020_NS / 1_000_000n)));
    const output = path.join(root, "boundary.zip");
    const plan = planArchive(scanResult(directories(1), { output, overwrite: true }), policy);
    const finding = { rule: "name.suspicious", severity: "warning" as const, path: "folder-0", message: "" };
    plan.findings.push(finding);
    const padding = MAX_MANIFEST_BYTES - Buffer.byteLength(JSON.stringify(document(plan), null, 2));
    finding.message = "é".repeat(Math.floor(padding / 2)) + (padding % 2 ? "x" : "");
    expect(Buffer.byteLength(JSON.stringify(document(plan), null, 2))).toBe(MAX_MANIFEST_BYTES);
    await write(plan);
    expect((await new ZipKit().extract({ archive: output, dryRun: true, checkMetadata: true })).reportOk).toBe(true);
    const original = await readFile(output);
    finding.message += "x";
    await expect(write(plan)).rejects.toMatchObject({ code: "write.manifest-too-large" });
    expect(await readFile(output)).toEqual(original);
    expect(await readdir(root)).toEqual(["boundary.zip"]);
  });
});
