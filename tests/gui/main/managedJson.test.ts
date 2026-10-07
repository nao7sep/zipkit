/**
 * Pins the ONE invariant the shared managed-JSON loader centralizes: the corrupt-file quarantine
 * runs OUTSIDE the read's failure handling, so a quarantine-rename failure PROPAGATES rather than
 * being swallowed into "return the defaults". The swallowed-failure bug this guards against is the
 * storage-path convention's forbidden "silently reset over a corrupt file": if the rename that moves
 * the corrupt bytes aside throws (a transient lock, an AV hold, a permission hiccup) and the loader
 * caught it and returned defaults, the corrupt bytes would still sit at the store path and the very
 * next save would overwrite them — the user's recoverable original gone with no `.invalid` copy.
 *
 * All three managed stores (config.json / layout.json / queue.json) route through
 * {@link loadManagedJson}, so the failure is injected once, at `node:fs/promises`' `rename`, and
 * asserted for each store: the load throws, and the corrupt bytes stay exactly where they were (no
 * quarantine created, no reset, nothing overwritten). The mock delegates every other fs call to the
 * real implementation and only fails `rename` when a test arms a one-shot failure, so the real
 * writeFile/mkdir/readFile used to set each case up still hit the throwaway root.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadLayout } from "../../../src/gui/main/layout.js";
import { writeManagedJson } from "../../../src/gui/main/managedJson.js";
import { loadQueue } from "../../../src/gui/main/persist.js";
import { loadSettings } from "../../../src/gui/main/settings.js";

// A one-shot rename failure armed per test; when unarmed, the mock delegates to the real rename so
// every atomic write (saveSettings/saveLayout/saveQueue) in setup still works against the real root.
const armedRenameError = vi.hoisted(() => ({ current: null as Error | null }));
const stageFault = vi.hoisted(() => ({ collision: false, write: null as Error | null, close: null as Error | null, future: null as { file: string; text: string } | null }));
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
        if (stageFault.future) {
          writeFileSync(stageFault.future.file, stageFault.future.text);
          stageFault.future = null;
        }
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

describe("loadManagedJson: a quarantine-rename failure propagates, never resets over corrupt bytes", () => {
  // Each store's load resolves its file under the ZIPKIT_DATA_DIR-relocated throwaway root, matching the
  // other file-I/O suites (settings/layout/persist).
  let root: string;
  const prev = process.env.ZIPKIT_DATA_DIR;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zipkit-home-"));
    process.env.ZIPKIT_DATA_DIR = root;
    armedRenameError.current = null;
    armedReadError.current = null;
    armedChmodError.current = null;
    stagedModes.length = 0;
    stageFault.collision = false;
    stageFault.write = null;
    stageFault.close = null;
    stageFault.future = null;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.ZIPKIT_DATA_DIR;
    else process.env.ZIPKIT_DATA_DIR = prev;
    armedRenameError.current = null;
    armedReadError.current = null;
    armedChmodError.current = null;
    stagedModes.length = 0;
    stageFault.collision = false;
    stageFault.write = null;
    stageFault.close = null;
    stageFault.future = null;
    await rm(root, { recursive: true, force: true });
  });

  it("config.json: the load throws and leaves the corrupt bytes in place (no quarantine, no reset)", async () => {
    const file = path.join(root, "config.json");
    const corruptBytes = "{ not json";
    writeFileSync(file, corruptBytes, "utf8");
    armedRenameError.current = new Error("EBUSY: quarantine rename blocked");

    await expect(loadSettings()).rejects.toThrow("EBUSY");

    // The corrupt file is untouched — not moved aside, not overwritten, and no `.invalid` created —
    // so a later run (once the lock clears) can still quarantine and preserve the original bytes.
    expect(readdirSync(root)).toEqual(["config.json"]);
    expect(readFileSync(file, "utf8")).toBe(corruptBytes);
  });

  it("layout.json: the load throws and leaves the corrupt bytes in place (no quarantine, no reset)", async () => {
    const file = path.join(root, "layout.json");
    const corruptBytes = "not json";
    writeFileSync(file, corruptBytes, "utf8");
    armedRenameError.current = new Error("EACCES: quarantine rename blocked");

    await expect(loadLayout()).rejects.toThrow("EACCES");

    expect(readdirSync(root)).toEqual(["layout.json"]);
    expect(readFileSync(file, "utf8")).toBe(corruptBytes);
  });

  it("queue.json: the load throws and leaves the corrupt bytes in place (no quarantine, no reset)", async () => {
    const file = path.join(root, "queue.json");
    const corruptBytes = "{ not json";
    writeFileSync(file, corruptBytes, "utf8");
    armedRenameError.current = new Error("EPERM: quarantine rename blocked");

    await expect(loadQueue()).rejects.toThrow("EPERM");

    expect(readdirSync(root)).toEqual(["queue.json"]);
    expect(readFileSync(file, "utf8")).toBe(corruptBytes);
  });

  it("the propagated failure is the rename error itself, so the caller logs the real cause", async () => {
    // The loader must not repackage or swallow the rename error — the caller's session log needs the
    // actual EBUSY/EACCES cause to diagnose why the corrupt file could not be quarantined.
    const file = path.join(root, "config.json");
    writeFileSync(file, "{ not json", "utf8");
    const injected = new Error("EBUSY: quarantine rename blocked");
    armedRenameError.current = injected;

    await expect(loadSettings()).rejects.toBe(injected);
  });

  it("a non-ENOENT read failure propagates instead of being treated as absence", async () => {
    const file = path.join(root, "config.json");
    writeFileSync(file, JSON.stringify({ formatVersion: 1, defaults: {} }));
    const injected = Object.assign(new Error("EACCES: read blocked"), { code: "EACCES" });
    armedReadError.current = injected;
    await expect(loadSettings()).rejects.toBe(injected);
    expect(readFileSync(file, "utf8")).toContain('"formatVersion":1');
  });
});

describe("writeManagedJson", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zipkit-managed-"));
    armedRenameError.current = null;
    armedReadError.current = null;
    armedChmodError.current = null;
    stagedModes.length = 0;
    stageFault.collision = false;
    stageFault.write = null;
    stageFault.close = null;
    stageFault.future = null;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(['{"formatVersion":2,"kept":true}', '{"formatVersion":0}', '{"kept":true}', 'broken'])
    ("refuses a changed save over an unusable current envelope: %s", async (current) => {
      const file = path.join(root, "queue.json");
      writeFileSync(file, current);
      const before = statSync(file);
      await expect(writeManagedJson(file, '{"formatVersion":1,"a":2}', { record: false })).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toBe(current);
      expect(statSync(file).ino).toBe(before.ino);
      expect(readdirSync(root)).toEqual(["queue.json"]);
    });

  it("preserves the live file and reports a current read failure", async () => {
    const file = path.join(root, "queue.json");
    writeFileSync(file, '{"formatVersion":1,"a":1}');
    const error = Object.assign(new Error("read denied"), { code: "EACCES" });
    armedReadError.current = error;
    await expect(writeManagedJson(file, '{"formatVersion":1,"a":2}', { record: false })).rejects.toBe(error);
    expect(readFileSync(file, "utf8")).toBe('{"formatVersion":1,"a":1}');
    expect(readdirSync(root)).toEqual(["queue.json"]);
  });

  it("preserves the live file and removes staging when mode restoration fails", async () => {
    const file = path.join(root, "queue.json");
    writeFileSync(file, '{"formatVersion":1,"a":1}');
    const error = Object.assign(new Error("chmod denied"), { code: "EPERM" });
    armedChmodError.current = error;
    await expect(writeManagedJson(file, '{"formatVersion":1,"a":2}', { record: false })).rejects.toBe(error);
    expect(readFileSync(file, "utf8")).toBe('{"formatVersion":1,"a":1}');
    expect(readdirSync(root)).toEqual(["queue.json"]);
  });

  it.skipIf(process.platform === "win32")("creates restrictive staging before bytes, then publishes the ordinary new-file mode", async () => {
    const file = path.join(root, "queue.json");
    await writeManagedJson(file, '{"formatVersion":1,"a":1}', { record: false });
    expect(stagedModes).toEqual([0o600 & ~process.umask()]);
    expect(statSync(file).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it("refuses a newer governing file installed after staging began and removes only its stage", async () => {
    const file = path.join(root, "queue.json");
    writeFileSync(file, '{"formatVersion":1,"jobs":[]}');
    const future = '{"formatVersion":2,"authored":"kept"}';
    stageFault.future = { file, text: future };
    await expect(writeManagedJson(file, '{"formatVersion":1,"jobs":[1]}', { record: false })).rejects.toThrow("newer than this build");
    expect(readFileSync(file, "utf8")).toBe(future);
    expect(readdirSync(root)).toEqual(["queue.json"]);
  });

  it("an exclusive stage collision preserves the preexisting stage", async () => {
    stageFault.collision = true;
    const file = path.join(root, "queue.json");
    await expect(writeManagedJson(file, '{"formatVersion":1}', { record: false })).rejects.toMatchObject({ code: "EEXIST" });
    const files = readdirSync(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.tmp$/);
    expect(readFileSync(path.join(root, files[0]!), "utf8")).toBe("another stage");
  });

  it("a failed stage write keeps its primary error when close also fails", async () => {
    const primary = new Error("write failed");
    stageFault.write = primary;
    stageFault.close = new Error("close failed");
    await expect(writeManagedJson(path.join(root, "queue.json"), '{"formatVersion":1}', { record: false })).rejects.toBe(primary);
    expect(readdirSync(root)).toEqual([]);
  });

  it("leaves the file as it is when the content is unchanged", async () => {
    const file = path.join(root, "layout.json");
    await writeManagedJson(file, '{"formatVersion":1,"a":1}', { record: false });
    const before = statSync(file);

    await writeManagedJson(file, '{"formatVersion":1,"a":1}', { record: false });

    expect(statSync(file).ino).toBe(before.ino);
    expect(readdirSync(root)).toEqual(["layout.json"]);
  });

  it("removes its temp and reports the rename's own error when the replace fails", async () => {
    const file = path.join(root, "queue.json");
    await writeManagedJson(file, '{"formatVersion":1,"a":1}', { record: false });
    const injected = Object.assign(new Error("EPERM: replace refused"), { code: "EPERM" });
    armedRenameError.current = injected;

    await expect(writeManagedJson(file, '{"formatVersion":1,"a":2}', { record: false })).rejects.toBe(injected);

    expect(readdirSync(root)).toEqual(["queue.json"]);
    expect(readFileSync(file, "utf8")).toBe('{"formatVersion":1,"a":1}');
  });

  // POSIX permissions; Windows keeps only a read-only flag, which a replace cannot write through.
  it.skipIf(process.platform === "win32")("keeps an existing file's permission mode when a changed save replaces it", async () => {
    const file = path.join(root, "queue.json");
    await writeManagedJson(file, '{"formatVersion":1,"a":1}', { record: false });
    chmodSync(file, 0o600);

    await writeManagedJson(file, '{"formatVersion":1,"a":2}', { record: false });

    expect(readFileSync(file, "utf8")).toBe('{"formatVersion":1,"a":2}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
