/**
 * Global test setup, run before every test file. Every temp path a test makes
 * through `os.tmpdir()` lands in a per-file temp root, and the file fails if
 * that root still holds anything once its tests finish: each test removes what
 * it creates. The root itself is removed either way, so a failing file leaves
 * nothing behind in the system temp folder.
 *
 * The storage root and the log directory are pinned inside that root too, so
 * the suite never writes into the developer's `~/.zipkit`; tests that assert on
 * stored files relocate them to their own temp dirs.
 */

import { mkdtempSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// The system temp folder, read once per worker before this file redirects it.
process.env.ZIPKIT_TEST_SYSTEM_TMPDIR ??= tmpdir();
const tempRoot = mkdtempSync(path.join(process.env.ZIPKIT_TEST_SYSTEM_TMPDIR, "zipkit-test-"));
// os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
process.env.TMPDIR = tempRoot;
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;

const dataDir = path.join(tempRoot, "data");
process.env.ZIPKIT_DATA_DIR = dataDir;
process.env.ZIPKIT_LOG_DIR = path.join(dataDir, "logs");

afterAll(async () => {
  const leftovers = readdirSync(tempRoot).filter((name) => name !== "data");
  await rm(tempRoot, { recursive: true, force: true });
  if (leftovers.length > 0) {
    throw new Error(`tests left temp entries behind: ${leftovers.sort().join(", ")}`);
  }
});

// In the jsdom environment (the renderer-component tests), stub scrollIntoView —
// jsdom does not implement it, and the listbox calls it when the active option
// changes. Guarded so node-environment test files (no `Element`) are unaffected.
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
