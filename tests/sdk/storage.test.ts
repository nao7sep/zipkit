/**
 * Tests for the single storage-root resolver — the one place that decides where
 * zipkit keeps its own files. The contract pinned here: the default is
 * `<home>/.zipkit`; `ZIPKIT_HOME` relocates the whole root; the override value is
 * `~`/env-expanded and absolutized *against the home directory* (never the
 * working directory); and an unusable override throws rather than silently
 * falling back. `env` and `home` are injected so the suite never touches the real
 * environment or home dir.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { storageRoot, StorageRootError } from "../../src/sdk/storage.js";

const ROOT = path.parse(path.resolve(".")).root;
const HOME = path.join(ROOT, "home", "tester");
const DATA_ROOT = path.join(ROOT, "data");
const ABSOLUTE_OVERRIDE = path.join(ROOT, "mnt", "data", "zipkit");

describe("storageRoot", () => {
  it("defaults to <home>/.zipkit when ZIPKIT_HOME is unset", () => {
    expect(storageRoot({}, HOME)).toBe(path.join(HOME, ".zipkit"));
  });

  it("treats an empty or whitespace ZIPKIT_HOME as unset", () => {
    expect(storageRoot({ ZIPKIT_HOME: "" }, HOME)).toBe(path.join(HOME, ".zipkit"));
    expect(storageRoot({ ZIPKIT_HOME: "   " }, HOME)).toBe(path.join(HOME, ".zipkit"));
  });

  it("uses an absolute ZIPKIT_HOME verbatim", () => {
    expect(storageRoot({ ZIPKIT_HOME: ABSOLUTE_OVERRIDE }, HOME)).toBe(ABSOLUTE_OVERRIDE);
  });

  it("expands a leading ~ against the home directory", () => {
    expect(storageRoot({ ZIPKIT_HOME: "~/profiles/work" }, HOME)).toBe(
      path.join(HOME, "profiles/work"),
    );
    expect(storageRoot({ ZIPKIT_HOME: "~" }, HOME)).toBe(HOME);
  });

  it("expands $VAR and ${VAR} references", () => {
    const env = { ZIPKIT_HOME: "$ROOT/zk", ROOT: DATA_ROOT };
    expect(storageRoot(env, HOME)).toBe(path.join(DATA_ROOT, "zk"));
    expect(storageRoot({ ZIPKIT_HOME: "${ROOT}/zk", ROOT: DATA_ROOT }, HOME)).toBe(path.join(DATA_ROOT, "zk"));
  });

  it("resolves a relative ZIPKIT_HOME against the home directory, never the cwd", () => {
    // The whole point of the convention: a relative override can never reintroduce
    // a cwd dependence. It is anchored to home regardless of process.cwd().
    expect(storageRoot({ ZIPKIT_HOME: "zipkit-data" }, HOME)).toBe(
      path.join(HOME, "zipkit-data"),
    );
    expect(storageRoot({ ZIPKIT_HOME: "../shared/zk" }, HOME)).toBe(
      path.resolve(HOME, "../shared/zk"),
    );
  });

  it("throws StorageRootError when the override expands to empty", () => {
    // An unknown variable expands to "", per shell semantics; the result is unusable.
    expect(() => storageRoot({ ZIPKIT_HOME: "$UNSET" }, HOME)).toThrow(StorageRootError);
  });
});
