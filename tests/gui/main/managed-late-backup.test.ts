import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writeManagedJson } from "../../../src/gui/main/managedJson.js";
import { MANAGED_IO_WAIT_MS } from "../../../src/gui/main/managed-io.js";

const controls = vi.hoisted(() => ({ entered: null as (() => void) | null, held: null as Promise<void> | null, recorded: null as (() => void) | null, records: [] as Array<{ file: string; bytes: Buffer }> }));
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
  controls.recorded?.();
} }));

it("a rename that commits after caller timeout records its exact committed bytes once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-late-backup-"));
  let release!: () => void;
  try {
    const file = path.join(root, "queue.json");
    await writeFile(file, '{"formatVersion":1,"jobs":[]}');
    const text = '{"formatVersion":1,"jobs":[{"id":"committed"}]}';
    controls.held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { controls.entered = resolve; });
    const recorded = new Promise<void>((resolve) => { controls.recorded = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const save = writeManagedJson(file, text);
    const failed = expect(save).rejects.toThrow(`did not finish within ${MANAGED_IO_WAIT_MS} ms`);
    await entered;
    await vi.advanceTimersByTimeAsync(MANAGED_IO_WAIT_MS);
    await failed;
    expect(controls.records).toEqual([]);
    expect(await readFile(file, "utf8")).toBe('{"formatVersion":1,"jobs":[]}');
    release();
    await recorded;
    expect(await readFile(file, "utf8")).toBe(text);
    expect(controls.records).toEqual([{ file, bytes: Buffer.from(text) }]);
    await writeManagedJson(file, text);
    expect(controls.records).toHaveLength(1);
  } finally {
    release?.();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
