/**
 * Pins what the shared managed-JSON loader and writer promise (store-recovery conventions): a refused
 * file, newer or unreadable, is reported and left exactly as it is, bytes, mode and modified time;
 * layout.json holds no authored work, so its unreadable bytes only fall back and are replaced. The
 * writer's faults are injected at `node:fs/promises`; the mock delegates every other call to the
 * real implementation, so the real files used to set each case up still hit the throwaway root.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadLayout, saveLayout } from "../../../src/gui/main/layout.js";
import { writeManagedJson } from "../../../src/gui/main/managedJson.js";
import { loadQueue } from "../../../src/gui/main/persist.js";
import { loadSettings } from "../../../src/gui/main/settings.js";
import { DEFAULT_LAYOUT } from "../../../src/gui/shared/layout.js";

// A one-shot rename failure armed per test; when unarmed, the mock delegates to the real rename so
// every atomic write (saveSettings/saveLayout/saveQueue) in setup still works against the real root.
const armedRenameError = vi.hoisted(() => ({ current: null as Error | null }));
const stageFault = vi.hoisted(() => ({ collision: false, write: null as Error | null, close: null as Error | null }));
const armedChmodError = vi.hoisted(() => ({ current: null as Error | null }));
const stagedModes = vi.hoisted(() => ([] as number[]));
const armedReadError = vi.hoisted(() => ({ current: null as Error | null }));

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (args[1] === "wx" && stageFault.collision) {
        stageFault.collision = false;
        writeFileSync(args[0] as string, "another stage");
      }
      const handle = await actual.open(...args);
      if (args[1] === "wx") {
        stagedModes.push((await handle.stat()).mode & 0o777);
        const write = stageFault.write;
        const close = stageFault.close;
        stageFault.write = null;
        stageFault.close = null;
        if (write) handle.writeFile = async () => { throw write; };
        if (close) {
          const actualClose = handle.close.bind(handle);
          handle.close = async () => { await actualClose(); throw close; };
        }
      }
      return handle;
    },
    chmod: (...args: Parameters<typeof actual.chmod>) => {
      if (armedChmodError.current) {
        const error = armedChmodError.current;
        armedChmodError.current = null;
        return Promise.reject(error);
      }
      return actual.chmod(...args);
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (armedReadError.current) {
        const err = armedReadError.current;
        armedReadError.current = null;
        return Promise.reject(err);
      }
      return actual.readFile(...args);
    },
    rename: (from: string, to: string) => {
      if (armedRenameError.current) {
        const err = armedRenameError.current;
        armedRenameError.current = null;
        return Promise.reject(err);
      }
      return actual.rename(from, to);
    },
  };
});

function resetFaults(): void {
  armedRenameError.current = null;
  armedReadError.current = null;
  armedChmodError.current = null;
  stagedModes.length = 0;
  stageFault.collision = false;
  stageFault.write = null;
  stageFault.close = null;
}

describe("loadManagedJson: a refused file is reported and left exactly as it is", () => {
  // Each store's load resolves its file under the ZIPKIT_DATA_DIR-relocated throwaway root, matching the
  // other file-I/O suites (settings/layout/persist).
  let root: string;
  const prev = process.env.ZIPKIT_DATA_DIR;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zipkit-home-"));
    process.env.ZIPKIT_DATA_DIR = root;
    resetFaults();
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.ZIPKIT_DATA_DIR;
    else process.env.ZIPKIT_DATA_DIR = prev;
    resetFaults();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["config.json", () => loadSettings()],
    ["queue.json", () => loadQueue()],
  ] as const)("%s: an unreadable file is refused with its bytes, mode, inode and modified time as they were", async (name, load) => {
    const file = path.join(root, name);
    writeFileSync(file, "corrupt original");
    chmodSync(file, 0o640);
    utimesSync(file, new Date("2000-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
    const before = statSync(file);

    const loaded = await load();

    expect(loaded.refused).toEqual({ file, reason: "unreadable" });
    expect(readdirSync(root)).toEqual([name]);
    expect(readFileSync(file, "utf8")).toBe("corrupt original");
    const after = statSync(file);
    expect([after.ino, after.mtimeMs, after.mode]).toEqual([before.ino, before.mtimeMs, before.mode]);
  });

  it("layout.json: a damaged file falls back to the default layout with no refusal, and the next save replaces it", async () => {
    const file = path.join(root, "layout.json");
    writeFileSync(file, "not json", "utf8");

    const load = await loadLayout();
    expect(load.refused).toBeNull();
    expect(load.value).toMatchObject(DEFAULT_LAYOUT);
    expect(readdirSync(root)).toEqual(["layout.json"]);

    await saveLayout({ ...DEFAULT_LAYOUT, jobsWidth: DEFAULT_LAYOUT.jobsWidth + 10 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ layout: { jobsWidth: DEFAULT_LAYOUT.jobsWidth + 10 } });
    expect(readdirSync(root)).toEqual(["layout.json"]);
  });

  it("layout.json: a newer file is refused all the same", async () => {
    const file = path.join(root, "layout.json");
    writeFileSync(file, '{"format":{"owner":"zipkit","kind":"layout","version":2},"layout":{}}');
    expect((await loadLayout()).refused).toEqual({ file, reason: "newer" });
  });

  it("a non-ENOENT read failure propagates instead of being treated as absence", async () => {
    const file = path.join(root, "config.json");
    writeFileSync(file, JSON.stringify({ newJobParameters: {} }));
    const injected = Object.assign(new Error("EACCES: read blocked"), { code: "EACCES" });
    armedReadError.current = injected;
    await expect(loadSettings()).rejects.toBe(injected);
    expect(readFileSync(file, "utf8")).toBe('{"newJobParameters":{}}');
  });
});

describe("writeManagedJson", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zipkit-managed-"));
    resetFaults();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(['broken', '[1,2]', 'null', ''])
    ("refuses a changed save over a live file that does not parse as a JSON object: %j", async (current) => {
      const file = path.join(root, "queue.json");
      writeFileSync(file, current);
      const before = statSync(file);
      await expect(writeManagedJson(file, '{"a":2}', { record: false })).rejects.toThrow("is invalid");
      expect(readFileSync(file, "utf8")).toBe(current);
      expect(statSync(file).ino).toBe(before.ino);
      expect(readdirSync(root)).toEqual(["queue.json"]);
    });

  it("replaces a live file of the current format, whatever its writer", async () => {
    const file = path.join(root, "queue.json");
    writeFileSync(file, '{"format":{"owner":"zipkit","kind":"queue","version":1},"writer":{"name":"elsewhere"},"jobs":[]}');
    await writeManagedJson(file, '{"jobs":[]}', { record: false });
    expect(readFileSync(file, "utf8")).toBe('{"jobs":[]}');
  });

  it.each([false, true])("never replaces a live file of a newer format (unreadable bytes disposable: %s)", async (replaceUnreadable) => {
    const file = path.join(root, "layout.json");
    const newer = '{"format":{"owner":"zipkit","kind":"layout","version":2},"layout":{}}';
    writeFileSync(file, newer);
    await expect(writeManagedJson(file, '{"layout":{}}', { record: false, replaceUnreadable })).rejects.toThrow(/newer format/);
    expect(readFileSync(file, "utf8")).toBe(newer);
  });

  it("replaces unreadable bytes only when the store says they are disposable", async () => {
    const file = path.join(root, "layout.json");
    writeFileSync(file, "broken");
    await writeManagedJson(file, '{"a":1}', { record: false, replaceUnreadable: true });
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
    expect(readdirSync(root)).toEqual(["layout.json"]);
  });

  it("creates no file when told not to create an absent one, and still replaces an existing one", async () => {
    const file = path.join(root, "config.json");
    await writeManagedJson(file, "{}", { record: false, createAbsent: false });
    expect(readdirSync(root)).toEqual([]);
    writeFileSync(file, '{"theme":"dark"}');
    await writeManagedJson(file, "{}", { record: false, createAbsent: false });
    expect(readFileSync(file, "utf8")).toBe("{}");
  });

  it("preserves the live file and reports a current read failure", async () => {
    const file = path.join(root, "queue.json");
    writeFileSync(file, '{"a":1}');
    const error = Object.assign(new Error("read denied"), { code: "EACCES" });
    armedReadError.current = error;
    await expect(writeManagedJson(file, '{"a":2}', { record: false })).rejects.toBe(error);
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
    expect(readdirSync(root)).toEqual(["queue.json"]);
  });

  it("preserves the live file and removes staging when mode restoration fails", async () => {
    const file = path.join(root, "queue.json");
    writeFileSync(file, '{"a":1}');
    const error = Object.assign(new Error("chmod denied"), { code: "EPERM" });
    armedChmodError.current = error;
    await expect(writeManagedJson(file, '{"a":2}', { record: false })).rejects.toBe(error);
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
    expect(readdirSync(root)).toEqual(["queue.json"]);
  });

  it.skipIf(process.platform === "win32")("creates restrictive staging before bytes, then publishes the ordinary new-file mode", async () => {
    const file = path.join(root, "queue.json");
    await writeManagedJson(file, '{"a":1}', { record: false });
    expect(stagedModes).toEqual([0o600 & ~process.umask()]);
    expect(statSync(file).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it("an exclusive stage collision preserves the preexisting stage", async () => {
    stageFault.collision = true;
    const file = path.join(root, "queue.json");
    await expect(writeManagedJson(file, '{}', { record: false })).rejects.toMatchObject({ code: "EEXIST" });
    const files = readdirSync(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.tmp$/);
    expect(readFileSync(path.join(root, files[0]!), "utf8")).toBe("another stage");
  });

  it("a failed stage write keeps its primary error when close also fails", async () => {
    const primary = new Error("write failed");
    stageFault.write = primary;
    stageFault.close = new Error("close failed");
    await expect(writeManagedJson(path.join(root, "queue.json"), '{}', { record: false })).rejects.toBe(primary);
    expect(readdirSync(root)).toEqual([]);
  });

  it("leaves the file as it is when the content is unchanged", async () => {
    const file = path.join(root, "layout.json");
    await writeManagedJson(file, '{"a":1}', { record: false });
    const before = statSync(file);

    await writeManagedJson(file, '{"a":1}', { record: false });

    expect(statSync(file).ino).toBe(before.ino);
    expect(readdirSync(root)).toEqual(["layout.json"]);
  });

  it("removes its temp and reports the rename's own error when the replace fails", async () => {
    const file = path.join(root, "queue.json");
    await writeManagedJson(file, '{"a":1}', { record: false });
    const injected = Object.assign(new Error("EPERM: replace refused"), { code: "EPERM" });
    armedRenameError.current = injected;

    await expect(writeManagedJson(file, '{"a":2}', { record: false })).rejects.toBe(injected);

    expect(readdirSync(root)).toEqual(["queue.json"]);
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
  });

  // POSIX permissions; Windows keeps only a read-only flag, which a replace cannot write through.
  it.skipIf(process.platform === "win32")("keeps an existing file's permission mode when a changed save replaces it", async () => {
    const file = path.join(root, "queue.json");
    await writeManagedJson(file, '{"a":1}', { record: false });
    chmodSync(file, 0o600);

    await writeManagedJson(file, '{"a":2}', { record: false });

    expect(readFileSync(file, "utf8")).toBe('{"a":2}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
