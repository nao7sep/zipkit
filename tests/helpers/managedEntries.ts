/**
 * Test helper: the entries in a relocated `ZIPKIT_HOME` root that are NOT the write-through backup
 * store's own files. The managed-JSON suites (settings/layout/persist) assert the exact directory
 * listing to prove an atomic save leaves no orphaned `<stem>-<nanoid>.tmp` behind. Since every managed
 * save now also records through the backup store, `backups.sqlite3` (and its WAL/SHM sidecars) legitimately
 * appear in the same root; filtering them out here keeps those "no temp leaked / correct files present"
 * assertions exact without hard-coding SQLite's journal-file names into every suite.
 */

import { readdirSync } from "node:fs";

/** The store file and its possible WAL-mode sidecars, all excluded from managed-listing assertions. */
const STORE_FILES = new Set(["backups.sqlite3", "backups.sqlite3-wal", "backups.sqlite3-shm"]);

/** The root's entries with the backup store's own files removed. */
export function managedEntries(root: string): string[] {
  return readdirSync(root).filter((name) => !STORE_FILES.has(name));
}
