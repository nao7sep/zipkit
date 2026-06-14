/**
 * Global test setup, run before every test file. Each `ZipKit` instance opens an
 * always-on per-session log; left at the default that would be `~/.zipkit/logs`,
 * polluting the developer's home directory. Pin it to a throwaway temp directory
 * per test file and remove that directory once the file's tests finish, so the
 * suite neither writes into the home dir nor leaks temp dirs. Tests that assert
 * log *contents* override `ZIPKIT_LOG_DIR` to their own temp dir.
 */

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const logDir = mkdtempSync(path.join(tmpdir(), "zipkit-test-logs-"));
process.env.ZIPKIT_LOG_DIR = logDir;

afterAll(async () => {
  await rm(logDir, { recursive: true, force: true });
});

// In the jsdom environment (the renderer-component tests), stub scrollIntoView —
// jsdom does not implement it, and the listbox calls it when the active option
// changes. Guarded so node-environment test files (no `Element`) are unaffected.
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
