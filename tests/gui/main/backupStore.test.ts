/**
 * Tests for the write-through data-backup store (src/gui/main/backupStore.ts) — the FLEET REFERENCE for
 * the data-backup conventions. Pins the load-bearing guarantees:
 *
 *  - record inserts a row whose content BLOB is BYTE-IDENTICAL to the input, including a CR/LF and a
 *    non-UTF-8 byte, with a correct SHA-256, a correct byte_size, the FULL absolute path, and an
 *    ISO-8601-ms `written_at_utc` in the serialized form (`2026-07-06T04:05:12.345Z`) — asserted to be
 *    that shape and explicitly NOT the `yyyymmdd-hhmmss-fff-utc` filename stamp.
 *  - one row per path per session (one launch): the session's first save inserts it, later saves replace
 *    its content, a save equal to the path's latest row writes nothing, and rows of earlier sessions are
 *    never changed; a store from before sessions gains the column and keeps its rows.
 *  - best-effort: an insert failure (raised by a real SQLite trigger inside the backups thread) never
 *    rejects out of record, logs exactly one warn, leaves prior rows untouched, and is rolled back so
 *    the next record lands.
 *  - write-through: after a REAL managed save (saveSettings), the exact bytes on disk are in the store.
 *
 * The store is written by its own thread, so each test waits for `record`'s promise (or closes the
 * store) before reading. Rows are read back with an INDEPENDENT node:sqlite connection so the store's
 * own writes — not a mock — are what the assertions see. `runtime.log` is mocked with a capturing logger so warn counts are exact
 * and no test writes into the developer's home dir.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Capturing logger swapped in for runtime.log so warn/ error lines are asserted exactly and nothing is
// written to the real session log. Hoisted so the vi.mock factory can close over it.
const logCalls = vi.hoisted(() => ({
  warn: [] as { message: string; fields?: Record<string, unknown> }[],
  error: [] as { message: string; fields?: Record<string, unknown> }[],
  session: "2026-10-09T01:00:00.000Z",
}));

vi.mock("../../../src/gui/main/runtime.js", () => ({
  log: {
    get session() {
      return logCalls.session;
    },
    debug() {},
    info() {},
    warn: (message: string, fields?: Record<string, unknown>) => logCalls.warn.push({ message, fields }),
    error: (message: string, fields?: Record<string, unknown>) => logCalls.error.push({ message, fields }),
  },
}));

interface Row {
  id: number;
  session_id: string | null;
  path: string;
  content: Uint8Array;
  content_sha256: string;
  byte_size: number;
  written_at_utc: string;
}

/** Read every row from the store with a fresh, independent connection (proves the store's own writes). */
function readRows(root: string): Row[] {
  const db = new DatabaseSync(path.join(root, "backups.sqlite3"));
  try {
    return db.prepare("SELECT * FROM backups ORDER BY id").all() as unknown as Row[];
  } finally {
    db.close();
  }
}

let root: string;
const prev = process.env.ZIPKIT_DATA_DIR;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "zipkit-backupstore-"));
  process.env.ZIPKIT_DATA_DIR = root;
  logCalls.warn.length = 0;
  logCalls.error.length = 0;
  logCalls.session = "2026-10-09T01:00:00.000Z";
});

afterEach(async () => {
  if (prev === undefined) delete process.env.ZIPKIT_DATA_DIR;
  else process.env.ZIPKIT_DATA_DIR = prev;
  const { closeBackupStore } = await import("../../../src/gui/main/backupStore.js");
  await closeBackupStore();
  vi.resetModules(); // fresh singleton per test so each opens against its own throwaway root
  await rm(root, { recursive: true, force: true });
});

describe("record: BLOB fidelity, hash, size, path, and timestamp shape", () => {
  it("stores byte-identical content (CR/LF + non-UTF-8 byte), correct sha256, size, absolute path, ISO-ms time", async () => {
    const { record } = await import("../../../src/gui/main/backupStore.js");
    // A CR/LF pair, a UTF-8 BOM, and a lone 0xFF (invalid UTF-8) — reading this as a string then storing
    // it would normalize the CR/LF, alter the BOM, or corrupt the 0xFF. The BLOB must be verbatim.
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62, 0xff, 0x00, 0x63]);
    const file = path.join(root, "config.json");

    await record(file, bytes);

    const rows = readRows(root);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Byte-identical: the exact bytes, not a decoded/normalized string.
    expect(Buffer.from(row.content).equals(bytes)).toBe(true);
    expect([...row.content]).toEqual([...bytes]);
    // sha256 over those raw bytes.
    expect(row.content_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(row.byte_size).toBe(bytes.byteLength);
    // Full absolute path, stored verbatim.
    expect(row.path).toBe(file);
    expect(path.isAbsolute(row.path)).toBe(true);
    // written_at_utc is the serialized ISO-8601-ms form (a data value) — NOT a filename stamp.
    expect(row.written_at_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.written_at_utc).not.toMatch(/utc$/); // never the yyyymmdd-hhmmss-fff-utc filename shape
    expect(new Date(row.written_at_utc).toISOString()).toBe(row.written_at_utc); // round-trips as a real instant
    // Success logs nothing.
    expect(logCalls.warn).toHaveLength(0);
    expect(logCalls.error).toHaveLength(0);
  });
});

describe("one row per path per session", () => {
  const text = (row: Row): string => Buffer.from(row.content).toString("utf8");

  /** End this launch's store and start the next launch's session. */
  async function nextSession(session: string): Promise<void> {
    const { closeBackupStore } = await import("../../../src/gui/main/backupStore.js");
    await closeBackupStore();
    logCalls.session = session;
  }

  it("keeps the session's first save of a path and replaces its content with later saves", async () => {
    const { record } = await import("../../../src/gui/main/backupStore.js");
    const file = path.join(root, "config.json");

    await record(file, Buffer.from("A", "utf8"));
    const first = readRows(root);
    await record(file, Buffer.from("B", "utf8"));
    await record(file, Buffer.from("A again", "utf8"));

    const rows = readRows(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first[0]!.id);
    expect(rows[0]!.session_id).toBe("2026-10-09T01:00:00.000Z");
    expect(text(rows[0]!)).toBe("A again");
    expect(rows[0]!.content_sha256).toBe(createHash("sha256").update("A again").digest("hex"));
    expect(rows[0]!.byte_size).toBe(7);
  });

  it("adds a row for a new session and leaves the earlier session's row as it was", async () => {
    const { record } = await import("../../../src/gui/main/backupStore.js");
    const file = path.join(root, "config.json");
    await record(file, Buffer.from("first launch", "utf8"));
    await nextSession("2026-10-09T02:00:00.000Z");

    await record(file, Buffer.from("second launch", "utf8"));

    const rows = readRows(root);
    expect(rows.map((row) => [row.session_id, text(row)])).toEqual([
      ["2026-10-09T01:00:00.000Z", "first launch"],
      ["2026-10-09T02:00:00.000Z", "second launch"],
    ]);
  });

  it("writes nothing for a first save equal to the earlier session's copy, or for an unchanged save", async () => {
    const { record } = await import("../../../src/gui/main/backupStore.js");
    const file = path.join(root, "config.json");
    await record(file, Buffer.from("same", "utf8"));
    await record(file, Buffer.from("same", "utf8"));
    await nextSession("2026-10-09T02:00:00.000Z");

    await record(file, Buffer.from("same", "utf8"));

    expect(readRows(root).map((row) => row.session_id)).toEqual(["2026-10-09T01:00:00.000Z"]);
  });

  it("keeps each path's row apart", async () => {
    const { record } = await import("../../../src/gui/main/backupStore.js");
    const p1 = path.join(root, "config.json");
    const p2 = path.join(root, "other.json");

    await record(p1, Buffer.from("shared", "utf8"));
    await record(p2, Buffer.from("shared", "utf8"));
    await record(p1, Buffer.from("changed", "utf8"));

    const rows = readRows(root);
    expect(rows.map((row) => [row.path, text(row)])).toEqual([[p1, "changed"], [p2, "shared"]]);
  });

  it("gives a store from before sessions the session column and keeps its rows as earlier history", async () => {
    const db = new DatabaseSync(path.join(root, "backups.sqlite3"));
    db.exec(`
      CREATE TABLE backups (id INTEGER PRIMARY KEY, path TEXT NOT NULL, content BLOB NOT NULL,
        content_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, written_at_utc TEXT NOT NULL);
      CREATE INDEX idx_backups_path_id ON backups (path, id);
    `);
    const file = path.join(root, "config.json");
    const insert = db.prepare("INSERT INTO backups (path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, ?, ?, ?)");
    for (const old of ["old 1", "old 2"]) {
      insert.run(file, Buffer.from(old), createHash("sha256").update(old).digest("hex"), old.length, "2026-10-01T00:00:00.000Z");
    }
    db.close();
    const { record } = await import("../../../src/gui/main/backupStore.js");

    await record(file, Buffer.from("new", "utf8"));
    await record(file, Buffer.from("newer", "utf8"));

    const rows = readRows(root);
    expect(rows.map((row) => [row.session_id, text(row)])).toEqual([
      [null, "old 1"],
      [null, "old 2"],
      ["2026-10-09T01:00:00.000Z", "newer"],
    ]);
    expect(logCalls.warn).toHaveLength(0);
  });
});

describe("best-effort: a record failure never throws, logs one warn, and does not disturb prior rows", () => {
  it("swallows an insert failure, logs exactly one warn, rolls back, and leaves the earlier row intact", async () => {
    const { record } = await import("../../../src/gui/main/backupStore.js");
    const file = path.join(root, "config.json");
    await record(file, Buffer.from("good", "utf8"));
    expect(readRows(root)).toHaveLength(1);

    // A real insert failure inside the backups thread: a trigger aborts the insert of one content.
    // The dedup lookup still runs, so the failure is isolated to the insert — exactly the "an insert
    // throws" case the convention names.
    const db = new DatabaseSync(path.join(root, "backups.sqlite3"));
    db.exec(
      "CREATE TRIGGER fail_changed BEFORE INSERT ON backups WHEN NEW.content = CAST('changed' AS BLOB) " +
        "BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END",
    );
    db.close();

    // A DIFFERENT content so dedup does not short-circuit before the insert is attempted.
    await expect(record(file, Buffer.from("changed", "utf8"))).resolves.toBeUndefined();

    // Exactly one warn, naming the file and carrying a reason; no error line.
    expect(logCalls.warn).toHaveLength(1);
    expect(logCalls.warn[0]!.message).toMatch(/failed to record/i);
    expect(logCalls.warn[0]!.fields?.file).toBe(file);
    expect(logCalls.warn[0]!.fields?.error).toMatchObject({ message: expect.stringMatching(/simulated insert failure/) });
    expect(logCalls.error).toHaveLength(0);
    // The session's row still holds the last save that was recorded.
    expect(readRows(root).map((row) => Buffer.from(row.content).toString("utf8"))).toEqual(["good"]);

    // The failed transaction was rolled back, so the same live store can record
    // the next save, which replaces the session's row, instead of remaining stuck
    // inside an open transaction.
    await record(file, Buffer.from("recovered", "utf8"));
    expect(readRows(root).map((row) => Buffer.from(row.content).toString("utf8"))).toEqual(["recovered"]);
  });

  it("logs one warn and disables recording for the session when the store cannot be opened", async () => {
    // Point ZIPKIT_DATA_DIR at a path whose parent is a FILE, so mkdir + open cannot succeed. record must
    // not throw, must warn exactly once (open failure), and must no-op every subsequent call (no repeat
    // warn per save — disabled for the session).
    const { writeFileSync } = await import("node:fs");
    const blocker = path.join(root, "blocker");
    writeFileSync(blocker, "x"); // a file where a directory would need to be
    process.env.ZIPKIT_DATA_DIR = path.join(blocker, "nested"); // parent is a file -> mkdir/open fails

    const { record } = await import("../../../src/gui/main/backupStore.js");
    await expect(record("/whatever/config.json", Buffer.from("a", "utf8"))).resolves.toBeUndefined();
    await expect(record("/whatever/config.json", Buffer.from("b", "utf8"))).resolves.toBeUndefined();

    // Exactly one warn total (the open failure), not one per record — disabled for the session.
    expect(logCalls.warn).toHaveLength(1);
    expect(logCalls.warn[0]!.message).toMatch(/could not open/i);
    expect(logCalls.error).toHaveLength(0);
  });
});

describe("existing stores open as they are", () => {
  it.each([
    ["an earlier build's format marker", "PRAGMA user_version = 1"],
    ["a higher marker", "PRAGMA user_version = 7"],
    ["no marker and a table of its own", "CREATE TABLE kept (x)"],
  ])("records into a store with %s", async (_case, setup) => {
    const db = new DatabaseSync(path.join(root, "backups.sqlite3"));
    db.exec(setup);
    db.close();

    const { record, closeBackupStore } = await import("../../../src/gui/main/backupStore.js");
    await record(path.join(root, "config.json"), Buffer.from("a", "utf8"));
    await closeBackupStore();

    expect(readRows(root)).toHaveLength(1);
    expect(logCalls.warn).toHaveLength(0);
  });
});

describe("write-through: a real managed save records the exact bytes after the rename", () => {
  it("saveSettings records config.json's exact on-disk bytes into the store", async () => {
    const { readFileSync } = await import("node:fs");
    const { saveSettings } = await import("../../../src/gui/main/settings.js");
    const { DEFAULT_OPTIONS, DEFAULT_SETTINGS } = await import("../../../src/gui/shared/spec.js");

    const { closeBackupStore } = await import("../../../src/gui/main/backupStore.js");

    await saveSettings({ ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_OPTIONS, level: 7 } });
    await closeBackupStore(); // the save does not wait for its record; closing does

    const file = path.join(root, "config.json");
    const onDisk = readFileSync(file); // the exact bytes the atomic write landed

    const rows = readRows(root);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.path).toBe(file); // full absolute path of the file as written
    expect(Buffer.from(row.content).equals(onDisk)).toBe(true); // byte-identical to what is on disk
    expect(row.content_sha256).toBe(createHash("sha256").update(onDisk).digest("hex"));
    expect(row.byte_size).toBe(onDisk.byteLength);
    expect(logCalls.warn).toHaveLength(0); // silent on success
  });

  it("a second saveSettings with identical settings records no new row", async () => {
    const { saveSettings } = await import("../../../src/gui/main/settings.js");
    const { DEFAULT_OPTIONS, DEFAULT_SETTINGS } = await import("../../../src/gui/shared/spec.js");
    const settings = { ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_OPTIONS, level: 3 } };

    const { closeBackupStore } = await import("../../../src/gui/main/backupStore.js");

    await saveSettings(settings);
    await saveSettings(settings); // the file would not change -> no write
    await closeBackupStore();

    expect(readRows(root)).toHaveLength(1);
  });
});
