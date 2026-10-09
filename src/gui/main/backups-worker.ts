/**
 * The thread that owns `backups.sqlite3` (data-backup conventions): the main
 * process posts each managed-text write here, so a slow or locked database never
 * holds the interface. It answers every record with `recorded` (written, or
 * skipped as unchanged) or `failed`, naming whether the store could not be opened
 * or the record itself failed. It imports only Node built-ins, so the tests run
 * this source as it is.
 *
 * SQLite binding: Node's built-in `node:sqlite`, not better-sqlite3, which is a
 * native addon that must be rebuilt against Electron's Node ABI on every Electron
 * bump. `node:sqlite` needs no native build and binds a `Uint8Array` as a BLOB
 * verbatim.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

export interface BackupsWorkerData {
  database: string;
}

/** One managed-text write: the full absolute `path` as written, the exact
 *  `content` bytes, and when the save landed (ISO-8601 UTC with milliseconds). */
export interface BackupRecord {
  path: string;
  content: Uint8Array;
  writtenAt: string;
}

export type BackupsRequest = { type: "record"; id: number; record: BackupRecord } | { type: "close" };

export type BackupsResponse =
  | { type: "recorded"; id: number }
  | { type: "failed"; id: number; stage: "open" | "record"; error: Record<string, unknown> }
  | { type: "closed" };

/**
 * The one add-only table. `content` is a BLOB of the exact bytes written — never
 * decoded text, so CR/LF, a BOM, and non-UTF-8 bytes are stored byte-identically.
 * `written_at_utc` is the serialized ISO-8601-ms form, a data value — never the
 * filename stamp. The `(path, id)` index serves the latest-row-per-path lookup.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS backups (
  id             INTEGER PRIMARY KEY,
  path           TEXT NOT NULL,
  content        BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  written_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_path_id ON backups (path, id);
`;

/** An error as plain data for the main process's log: its own fields (SQLite's
 *  `code` and `errcode`) plus name, message and stack. */
function errorData(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) };
  return { ...err, name: err.name, message: err.message, stack: err.stack };
}

interface Statements {
  latest: StatementSync;
  insert: StatementSync;
}

class BackupsStore {
  #db: DatabaseSync | null = null;
  #statements: Statements | null = null;
  #openFailure: unknown = null;
  readonly #database: string;

  constructor(database: string) {
    this.#database = database;
  }

  /** Opened on the first record, so a session that saves nothing creates no
   *  database; a failed open is not retried. */
  open(): Statements {
    if (this.#statements) return this.#statements;
    if (this.#openFailure !== null) throw this.#openFailure;
    let db: DatabaseSync | undefined;
    try {
      // not recorded: backups.sqlite3 is the store itself — binary, and written
      // here, not through the managed-text atomic-write path (data-backup
      // conventions, "A binary store, excluded from itself").
      // The first writer under the root does the `mkdir -p` (storage-path
      // conventions); the store may be the first thing written on a fresh root.
      mkdirSync(path.dirname(this.#database), { recursive: true });
      db = new DatabaseSync(this.#database);
      // Independent diagnostic readers may briefly contend with a checkpoint/write.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(SCHEMA);
      this.#db = db;
      this.#statements = {
        latest: db.prepare("SELECT content_sha256 AS h FROM backups WHERE path = ? ORDER BY id DESC LIMIT 1"),
        insert: db.prepare(
          "INSERT INTO backups (path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, ?, ?, ?)",
        ),
      };
      return this.#statements;
    } catch (err) {
      this.#openFailure = err;
      try {
        db?.close();
      } catch {
        // The open failure is the actionable one.
      }
      throw err;
    }
  }

  /**
   * Dedup by content hash, per path: the insert is skipped when the new
   * content's SHA-256 equals the latest row's for the same path, so an unchanged
   * re-save writes no row while a revert (which differs from the preceding row)
   * is recorded. The lookup and the insert are one immediate transaction, so the
   * dedup invariant holds at the database boundary.
   */
  record(statements: Statements, { path: file, content, writtenAt }: BackupRecord): void {
    const db = this.#db!;
    const hash = createHash("sha256").update(content).digest("hex");
    db.exec("BEGIN IMMEDIATE");
    try {
      const latest = statements.latest.get(file) as { h: string } | undefined;
      if (latest?.h !== hash) statements.insert.run(file, content, hash, content.byteLength, writtenAt);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The record failure is the actionable one.
      }
      throw err;
    }
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
    this.#statements = null;
  }
}

if (parentPort) {
  const port = parentPort;
  const { database } = workerData as BackupsWorkerData;
  const store = new BackupsStore(database);
  const reply = (response: BackupsResponse): void => port.postMessage(response);
  port.on("message", (request: BackupsRequest) => {
    if (request.type === "close") {
      try {
        store.close();
      } finally {
        reply({ type: "closed" });
        port.close();
      }
      return;
    }
    let statements: Statements;
    try {
      statements = store.open();
    } catch (err) {
      reply({ type: "failed", id: request.id, stage: "open", error: errorData(err) });
      return;
    }
    try {
      store.record(statements, request.record);
      reply({ type: "recorded", id: request.id });
    } catch (err) {
      reply({ type: "failed", id: request.id, stage: "record", error: errorData(err) });
    }
  });
}
