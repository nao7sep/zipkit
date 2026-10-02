/**
 * Global test setup, run before every test file. Each `ZipKit` instance opens an
 * always-on per-session log, and the app's log writes `records.sqlite3` under the
 * storage root; left at the defaults both would land in `~/.zipkit`, polluting the
 * developer's home directory. Pin the storage root and the log directory to a
 * throwaway temp directory per test file and remove it once the file's tests
 * finish, so the suite neither writes into the home dir nor leaks temp dirs.
 * Tests that assert on stored files relocate them to their own temp dirs.
 */

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "zipkit-test-data-"));
process.env.ZIPKIT_DATA_DIR = dataDir;
process.env.ZIPKIT_LOG_DIR = path.join(dataDir, "logs");

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// In the jsdom environment (the renderer-component tests), stub scrollIntoView —
// jsdom does not implement it, and the listbox calls it when the active option
// changes. Guarded so node-environment test files (no `Element`) are unaffected.
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
