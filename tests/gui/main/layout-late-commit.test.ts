import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadLayout, recordsListWidth, saveLayout, saveRecordsListWidth, serializeLayout } from "../../../src/gui/main/layout.js";
import { managedIO, MANAGED_IO_WAIT_MS } from "../../../src/gui/main/managed-io.js";

const controls = vi.hoisted(() => ({ entered: null as (() => void) | null, held: null as Promise<void> | null }));
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    const entered = controls.entered;
    if (entered) { controls.entered = null; entered(); await controls.held; }
    return actual.rename(...args);
  } };
});

it("a layout patch follows the physical late commit and retains the other window's committed width", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-layout-late-"));
  const previousRoot = process.env.ZIPKIT_DATA_DIR;
  process.env.ZIPKIT_DATA_DIR = root;
  const file = path.join(root, "layout.json");
  let release!: () => void;
  try {
    await writeFile(file, serializeLayout({ jobsWidth: 300, progressWidth: 360, recordsListWidth: 500 }));
    await loadLayout();
    controls.held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { controls.entered = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const save = saveRecordsListWidth(420);
    const failed = expect(save).rejects.toThrow(`did not finish within ${MANAGED_IO_WAIT_MS} ms`);
    await entered;
    await vi.advanceTimersByTimeAsync(MANAGED_IO_WAIT_MS);
    await failed;
    expect(recordsListWidth()).toBe(500);
    const pane = saveLayout({ jobsWidth: 320, progressWidth: 380 });
    release();
    await pane;
    expect(recordsListWidth()).toBe(420);
    expect(JSON.parse(await readFile(file, "utf8")).layout)
      .toEqual({ jobsWidth: 320, progressWidth: 380, recordsListWidth: 420 });
  } finally {
    release?.();
    vi.useRealTimers();
    await managedIO(file, async () => {});
    if (previousRoot === undefined) delete process.env.ZIPKIT_DATA_DIR;
    else process.env.ZIPKIT_DATA_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
