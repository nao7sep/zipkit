import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeManagedText } from "../../../src/gui/main/managed-write.js";
import { writeManagedJson } from "../../../src/gui/main/managedJson.js";

const faults = vi.hoisted(() => ({
  events: [] as string[], file: null as Error | null, hold: null as Promise<void> | null, record: vi.fn(),
}));
vi.mock("../../../src/gui/main/backupStore.js", () => ({ record: faults.record }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => { faults.events.push("rename"); await fs.rename(...args); },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const sync = handle.sync.bind(handle), close = handle.close.bind(handle);
      handle.sync = async () => {
        faults.events.push("file sync");
        // On POSIX the final ordinary mode must precede synchronization.
        if (args[1] === "wx" && process.platform !== "win32") expect((await handle.stat()).mode & 0o777).toBe(0o666 & ~process.umask());
        if (faults.hold) await faults.hold;
        if (faults.file) throw faults.file;
        await sync();
      };
      handle.close = async () => { faults.events.push("file close"); await close(); };
      return handle;
    },
  };
});
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zipkit-durable-settings-"));
  faults.events = []; faults.file = null; faults.hold = null;
  faults.record.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => { faults.hold = null; await rm(root, { recursive: true, force: true }); });
const save = () => writeManagedText(path.join(root, "config.json"), Buffer.from('{"theme":"dark"}'), undefined, { durable: true });

it("flushes the file before publication and nothing after the rename", async () => {
  expect(await save()).toBe(true);
  expect(faults.events).toEqual(["file sync", "file close", "rename"]);
  expect(await readFile(path.join(root, "config.json"), "utf8")).toBe('{"theme":"dark"}');
});

it("a failed file flush preserves the previous settings and removes only its staging file", async () => {
  const file = path.join(root, "config.json");
  await writeFile(file, '{"theme":"light"}');
  const error = faults.file = Object.assign(new Error("device failed"), { code: "EIO" });
  await expect(save()).rejects.toBe(error);
  expect(await readFile(file, "utf8")).toBe('{"theme":"light"}');
  expect(await readdir(root)).toEqual(["config.json"]);
  expect(faults.events).not.toContain("rename");
});

it("a pending flush retains the primary write until its actual settlement", async () => {
  let finish!: () => void;
  faults.hold = new Promise<void>((resolve) => { finish = resolve; });
  let settled = false;
  const pending = save().then(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(faults.events).toContain("file sync"));
    expect(settled).toBe(false);
    expect(await readdir(root)).not.toContain("config.json");
    expect(faults.events).not.toContain("rename");
    finish(); await pending;
    expect(settled).toBe(true);
  } finally { finish(); await pending; }
});

it("reconstructible state does not request primary-save synchronization", async () => {
  await writeManagedText(path.join(root, "queue.json"), Buffer.from('{"jobs":[]}'));
  expect(faults.events).toEqual(["file close", "rename"]);
});

it("absent all-default settings record no nonexistent primary file", async () => {
  await writeManagedJson(path.join(root, "config.json"), "{}", { createAbsent: false, durable: true, record: true });
  expect(faults.record).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});
