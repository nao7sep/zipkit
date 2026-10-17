/**
 * Run before every test file. Every temp path a test makes through
 * `os.tmpdir()` lands in a per-file temp root, and the file fails if that root
 * still holds anything once its tests finish: each test removes what it
 * creates. The root itself is removed either way, so a failing file leaves
 * nothing behind in the system temp folder.
 */

import { mkdtempSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// The system temp folder, read once per worker before this file redirects it.
process.env.ZIPKIT_TEST_SYSTEM_TMPDIR ??= tmpdir();
const tempRoot = mkdtempSync(path.join(process.env.ZIPKIT_TEST_SYSTEM_TMPDIR, "zipkit-sdk-test-"));
// os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
process.env.TMPDIR = tempRoot;
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;

afterAll(async () => {
  const leftovers = readdirSync(tempRoot);
  await rm(tempRoot, { recursive: true, force: true });
  if (leftovers.length > 0) {
    throw new Error(`tests left temp entries behind: ${leftovers.sort().join(", ")}`);
  }
});
