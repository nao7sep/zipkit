import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { layoutWritesSettled, loadLayout, recordsListWidth, saveLayout, saveRecordsListWidth, serializeLayout } from "../../../src/gui/main/layout.js";

const controls = vi.hoisted(() => ({
  loadGate: null as { entered(): void; held: Promise<void> } | null,
  writeFailure: null as Error | null,
}));
vi.mock("../../../src/gui/main/managedJson.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/gui/main/managedJson.js")>();
  return {
    ...actual,
    loadManagedJson: async (...args: Parameters<typeof actual.loadManagedJson>) => {
      const loaded = await actual.loadManagedJson(...args);
      const gate = controls.loadGate;
      controls.loadGate = null;
      if (gate) { gate.entered(); await gate.held; }
      return loaded;
    },
    writeManagedJson: (...args: Parameters<typeof actual.writeManagedJson>) => {
      const failure = controls.writeFailure;
      controls.writeFailure = null;
      return failure ? Promise.reject(failure) : actual.writeManagedJson(...args);
    },
  };
});
let root: string;
const originalRoot = process.env.ZIPKIT_DATA_DIR;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zipkit-layout-order-"));
  process.env.ZIPKIT_DATA_DIR = root;
  controls.loadGate = null;
  controls.writeFailure = null;
});
afterEach(async () => {
  await layoutWritesSettled().catch(() => {});
  if (originalRoot === undefined) delete process.env.ZIPKIT_DATA_DIR;
  else process.env.ZIPKIT_DATA_DIR = originalRoot;
  await rm(root, { recursive: true, force: true });
});

it("a held layout read settles before later window patches, which keep each other's fields", async () => {
  await writeFile(path.join(root, "layout.json"), serializeLayout({ jobsWidth: 300, progressWidth: 360, recordsListWidth: 500 }));
  let release!: () => void;
  let entered!: () => void;
  const seen = new Promise<void>((resolve) => { entered = resolve; });
  controls.loadGate = { entered, held: new Promise<void>((resolve) => { release = resolve; }) };
  const loading = loadLayout();
  await seen;
  const pane = saveLayout({ jobsWidth: 320, progressWidth: 380 });
  const records = saveRecordsListWidth(420);
  release();
  await Promise.all([loading, pane, records]);
  expect(JSON.parse(await readFile(path.join(root, "layout.json"), "utf8")).layout)
    .toEqual({ jobsWidth: 320, progressWidth: 380, recordsListWidth: 420 });
  expect(recordsListWidth()).toBe(420);
});

it("a failed Records width save leaves the saved state used by a later pane patch intact", async () => {
  await writeFile(path.join(root, "layout.json"), serializeLayout({ jobsWidth: 300, progressWidth: 360, recordsListWidth: 500 }));
  await loadLayout();
  const failure = new Error("save failed");
  controls.writeFailure = failure;
  await expect(saveRecordsListWidth(420)).rejects.toBe(failure);
  expect(recordsListWidth()).toBe(500);
  await saveLayout({ jobsWidth: 320, progressWidth: 380 });
  expect(JSON.parse(await readFile(path.join(root, "layout.json"), "utf8")).layout)
    .toEqual({ jobsWidth: 320, progressWidth: 380, recordsListWidth: 500 });
});
