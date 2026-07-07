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
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A one-shot rename failure armed per test; when unarmed, the mock delegates to the real rename so
// every atomic write (saveSettings/saveLayout/saveQueue) in setup still works against the real root.
const armedRenameError = vi.hoisted(() => ({ current: null as Error | null }));

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
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
  // Each store's load resolves its file under the ZIPKIT_HOME-relocated throwaway root, matching the
  // other file-I/O suites (settings/layout/persist).
  let root: string;
  const prev = process.env.ZIPKIT_HOME;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zipkit-home-"));
    process.env.ZIPKIT_HOME = root;
    armedRenameError.current = null;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.ZIPKIT_HOME;
    else process.env.ZIPKIT_HOME = prev;
    armedRenameError.current = null;
    await rm(root, { recursive: true, force: true });
  });

  it("config.json: the load throws and leaves the corrupt bytes in place (no quarantine, no reset)", async () => {
    const { loadSettings } = await import("../../../src/gui/main/settings.js");
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
    const { loadLayout } = await import("../../../src/gui/main/layout.js");
    const file = path.join(root, "layout.json");
    const corruptBytes = "not json";
    writeFileSync(file, corruptBytes, "utf8");
    armedRenameError.current = new Error("EACCES: quarantine rename blocked");

    await expect(loadLayout()).rejects.toThrow("EACCES");

    expect(readdirSync(root)).toEqual(["layout.json"]);
    expect(readFileSync(file, "utf8")).toBe(corruptBytes);
  });

  it("queue.json: the load throws and leaves the corrupt bytes in place (no quarantine, no reset)", async () => {
    const { loadQueue } = await import("../../../src/gui/main/persist.js");
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
    const { loadSettings } = await import("../../../src/gui/main/settings.js");
    const file = path.join(root, "config.json");
    writeFileSync(file, "{ not json", "utf8");
    const injected = new Error("EBUSY: quarantine rename blocked");
    armedRenameError.current = injected;

    await expect(loadSettings()).rejects.toBe(injected);
  });
});
