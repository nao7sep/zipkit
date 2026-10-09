import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writeManagedJson } from "../../../src/gui/main/managedJson.js";
import { MANAGED_IO_WAIT_MS } from "../../../src/gui/main/managed-io.js";

const controls = vi.hoisted(() => ({ entered: null as (() => void) | null, held: null as Promise<void> | null, records: [] as Array<{ file: string; bytes: Buffer }> }));
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    controls.entered?.();
    await controls.held;
    return actual.rename(...args);
  } };
});
vi.mock("../../../src/gui/main/backupStore.js", () => ({ record: async (file: string, bytes: Buffer) => {
  controls.records.push({ file, bytes });
} }));

it("a save held at its rename waits for the actual outcome, never a caller timeout, and records its bytes once when asked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-late-backup-"));
  let release!: () => void;
  try {
    const file = path.join(root, "queue.json");
    await writeFile(file, '{"jobs":[]}');
    const text = '{"jobs":[{"id":"committed"}]}';
    controls.held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { controls.entered = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let outcome: "pending" | "saved" | "failed" = "pending";
    const save = writeManagedJson(file, text, { record: true }).then(() => { outcome = "saved"; }, () => { outcome = "failed"; });
    await entered;
    // Well past the startup read bound: an in-session save does not report failure while its
    // write may still land.
    await vi.advanceTimersByTimeAsync(10 * MANAGED_IO_WAIT_MS);
    expect(outcome).toBe("pending");
    expect(controls.records).toEqual([]);
    expect(await readFile(file, "utf8")).toBe('{"jobs":[]}');
    release();
    await save;
    expect(outcome).toBe("saved");
    expect(await readFile(file, "utf8")).toBe(text);
    expect(controls.records).toEqual([{ file, bytes: Buffer.from(text) }]);
    await writeManagedJson(file, text, { record: true });
    expect(controls.records).toHaveLength(1);
    // A save that does not ask for a record leaves the history alone.
    await writeManagedJson(path.join(root, "queue.json"), '{"jobs":[]}');
    expect(controls.records).toHaveLength(1);
  } finally {
    release?.();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
