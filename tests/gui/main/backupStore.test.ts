/**
 * Tests for the write-through data-backup store (src/gui/main/backupStore.ts) — the FLEET REFERENCE for
 * the data-backup conventions. Pins the load-bearing guarantees:
 *
 *  - record inserts a row whose content BLOB is BYTE-IDENTICAL to the input, including a CR/LF and a
 *    non-UTF-8 byte, with a correct SHA-256, a correct byte_size, the FULL absolute path, and an
 *    ISO-8601-ms `written_at_utc` in the serialized form (`2026-07-06T04:05:12.345Z`) — asserted to be
 *    that shape and explicitly NOT the `yyyymmdd-hhmmss-fff-utc` filename stamp.
 *  - dedup: an unchanged re-save of the same path writes no new row; a changed save writes one; a revert
 *    to earlier content writes one (it differs from the immediately-preceding row).
 *  - best-effort: an injected insert failure never throws out of record, logs exactly one warn, and
 *    leaves prior rows untouched (the save it follows is unaffected).
 *  - write-through: after a REAL managed save (saveSettings), the exact bytes on disk are in the store.
 *
 * Rows are read back with an INDEPENDENT node:sqlite connection so the store's own writes — not a mock —
 * are what the assertions see. `runtime.log` is mocked with a capturing logger so warn counts are exact
 * and no test writes into the developer's home dir.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

// Capturing logger swapped in for runtime.log so warn/ error lines are asserted exactly and nothing is
// written to the real session log. Hoisted so the vi.mock factory can close over it.
const logCalls = vi.hoisted(() => ({
  warn: [] as { message: string; fields?: Record<string, unknown> }[],
  error: [] as { message: string; fields?: Record<string, unknown> }[],
}));

vi.mock("../../../src/gui/main/runtime.js", () => ({
  log: {
    debug() {},
    info() {},
    warn: (message: string, fields?: Record<string, unknown>) => logCalls.warn.push({ message, fields }),
    error: (message: string, fields?: Record<string, unknown>) => logCalls.error.push({ message, fields }),
  },
}));

interface Row {
  id: number;
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
const prev = process.env.ZIPKIT_HOME;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "zipkit-backupstore-"));
  process.env.ZIPKIT_HOME = root;
  logCalls.warn.length = 0;
  logCalls.error.length = 0;
});

afterEach(async () => {
  if (prev === undefined) delete process.env.ZIPKIT_HOME;
  else process.env.ZIPKIT_HOME = prev;
  const { closeBackupStore } = await import("../../../src/gui/main/backupStore.js");
  closeBackupStore();
  vi.resetModules(); // fresh singleton per test so each opens against its own throwaway root
  vi.doUnmock("node:sqlite");
  await rm(root, { recursive: true, force: true });
});

describe("record: BLOB fidelity, hash, size, path, and timestamp shape", () => {
  it("stores byte-identical content (CR/LF + non-UTF-8 byte), correct sha256, size, absolute path, ISO-ms time", async () => {
    const { record } = await import("../../../src/gui/main/backupStore.js");
    // A CR/LF pair, a UTF-8 BOM, and a lone 0xFF (invalid UTF-8) — reading this as a string then storing
    // it would normalize the CR/LF, alter the BOM, or corrupt the 0xFF. The BLOB must be verbatim.
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62, 0xff, 0x00, 0x63]);
    const file = path.join(root, "config.json");

    record(file, bytes);

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

describe("dedup by content hash, per path", () => {
  it("skips an unchanged re-save (no new row) but records a genuinely changed save", async () => {
    const { record } = await import("../../../src/gui/main/backupStore.js");
    const file = path.join(root, "config.json");
    const v1 = Buffer.from("alpha", "utf8");
    const v2 = Buffer.from("beta", "utf8");

    record(file, v1);
    record(file, v1); // identical — deduped, no new row
    expect(readRows(root)).toHaveLength(1);

    record(file, v2); // changed — recorded
    const rows = readRows(root);
    expect(rows).toHaveLength(2);
    expect(Buffer.from(rows[1]!.content).toString("utf8")).toBe("beta");
  });

  it("records a revert to earlier content as a new row (differs from the immediately-preceding row)", async () => {
    const { record } = await import("../../../src/gui/main/backupStore.js");
    const file = path.join(root, "config.json");
    const a = Buffer.from("A", "utf8");
    const b = Buffer.from("B", "utf8");

    record(file, a); // row 1: A
    record(file, b); // row 2: B
    record(file, a); // row 3: A again — a revert, differs from the preceding row (B), so it IS recorded

    const rows = readRows(root);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => Buffer.from(r.content).toString("utf8"))).toEqual(["A", "B", "A"]);
  });

  it("dedups per path, so two different paths never collide", async () => {
    const { record } = await import("../../../src/gui/main/backupStore.js");
    const same = Buffer.from("shared", "utf8");
    const p1 = path.join(root, "config.json");
    const p2 = path.join(root, "queue.json");

    record(p1, same);
    record(p2, same); // same content, DIFFERENT path — recorded (dedup is per path)
    record(p1, same); // same content, same path as row 1 — deduped

    const rows = readRows(root);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.path).sort()).toEqual([p1, p2].sort());
  });
});

describe("best-effort: a record failure never throws, logs one warn, and does not disturb prior rows", () => {
  it("swallows an injected insert failure, logs exactly one warn, and leaves the earlier row intact", async () => {
    // First record a good row through the real binding so there is prior history to prove is untouched.
    {
      const { record } = await import("../../../src/gui/main/backupStore.js");
      record(path.join(root, "config.json"), Buffer.from("good", "utf8"));
      const { closeBackupStore } = await import("../../../src/gui/main/backupStore.js");
      closeBackupStore();
    }
    expect(readRows(root)).toHaveLength(1);

    // Now make the NEXT open's insert throw: wrap DatabaseSync so prepare() of the INSERT yields a
    // statement whose run() throws. get()/exec() still work, so open + dedup lookup succeed and the
    // failure is isolated to the insert — exactly the "an insert throws" case the convention names.
    vi.resetModules();
    vi.doMock("node:sqlite", async (importActual) => {
      const actual = await importActual<typeof import("node:sqlite")>();
      class FailingInsertDb extends actual.DatabaseSync {
        override prepare(sql: string): StatementSync {
          const stmt = super.prepare(sql);
          if (/^\s*INSERT/i.test(sql)) {
            return new Proxy(stmt, {
              get(target, prop, receiver) {
                if (prop === "run") {
                  return () => {
                    throw new Error("disk full: simulated insert failure");
                  };
                }
                return Reflect.get(target, prop, receiver);
              },
            }) as typeof stmt;
          }
          return stmt;
        }
      }
      return { ...actual, DatabaseSync: FailingInsertDb };
    });

    const { record } = await import("../../../src/gui/main/backupStore.js");
    // A DIFFERENT content so dedup does not short-circuit before the insert is attempted.
    expect(() => record(path.join(root, "config.json"), Buffer.from("changed", "utf8"))).not.toThrow();

    // Exactly one warn, naming the file and carrying a reason; no error line.
    expect(logCalls.warn).toHaveLength(1);
    expect(logCalls.warn[0]!.message).toMatch(/failed to record/i);
    expect(logCalls.warn[0]!.fields?.file).toBe(path.join(root, "config.json"));
    expect(logCalls.warn[0]!.fields?.error).toBeDefined();
    expect(logCalls.error).toHaveLength(0);

    // The earlier good row is untouched — the failure disturbed nothing that had already been recorded.
    const rows = readRows(root);
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.content).toString("utf8")).toBe("good");
  });

  it("logs one warn and disables recording for the session when the store cannot be opened", async () => {
    // Point ZIPKIT_HOME at a path whose parent is a FILE, so mkdir + open cannot succeed. record must
    // not throw, must warn exactly once (open failure), and must no-op every subsequent call (no repeat
    // warn per save — disabled for the session).
    const { writeFileSync } = await import("node:fs");
    const blocker = path.join(root, "blocker");
    writeFileSync(blocker, "x"); // a file where a directory would need to be
    process.env.ZIPKIT_HOME = path.join(blocker, "nested"); // parent is a file -> mkdir/open fails

    const { record } = await import("../../../src/gui/main/backupStore.js");
    expect(() => record("/whatever/config.json", Buffer.from("a", "utf8"))).not.toThrow();
    expect(() => record("/whatever/config.json", Buffer.from("b", "utf8"))).not.toThrow();

    // Exactly one warn total (the open failure), not one per record — disabled for the session.
    expect(logCalls.warn).toHaveLength(1);
    expect(logCalls.warn[0]!.message).toMatch(/could not open/i);
    expect(logCalls.error).toHaveLength(0);
  });
});

describe("write-through: a real managed save records the exact bytes after the rename", () => {
  it("saveSettings records config.json's exact on-disk bytes into the store", async () => {
    const { readFileSync } = await import("node:fs");
    const { saveSettings } = await import("../../../src/gui/main/settings.js");
    const { DEFAULT_OPTIONS } = await import("../../../src/gui/shared/spec.js");

    await saveSettings({ defaults: { ...DEFAULT_OPTIONS, level: 7 }, uiFontFamily: "Iosevka" });

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

  it("a second saveSettings with identical settings is deduped (write-through respects the content skip)", async () => {
    const { saveSettings } = await import("../../../src/gui/main/settings.js");
    const { DEFAULT_OPTIONS } = await import("../../../src/gui/shared/spec.js");
    const settings = { defaults: { ...DEFAULT_OPTIONS, level: 3 }, uiFontFamily: "" };

    await saveSettings(settings);
    await saveSettings(settings); // identical serialized bytes -> deduped

    expect(readRows(root)).toHaveLength(1);
  });
});
