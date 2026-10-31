/**
 * The file identity header (file-identity conventions) on every file the app
 * writes in its own formats: the three JSON stores and both databases. One
 * helper builds and checks it. A reader checks `format` alone: owner and kind
 * must be exactly what it expects and version 1 is read; a higher version is
 * newer and is left untouched; anything else is unreadable. `writer` is
 * written on every save and never read.
 *
 * It imports nothing but the envelope, so the worker threads load it too; the
 * writer comes from the caller, since only the main bundle knows the version.
 */

import type { DatabaseSync } from "node:sqlite";
import { InvalidManagedJsonError, isPlainObject } from "./managed-json-envelope.ts";

export const FILE_OWNER = "zipkit";
/** The one version of every format the app owns. */
export const FORMAT_VERSION = 1;

/** Each file the app writes in a format of its own. */
export type FileKind = "config" | "queue" | "layout" | "records" | "backups";

/** The program that serialized a file: its package name and release. */
export interface FileWriter {
  name: string;
  version: string;
}

/** A file written by a later format version than this build reads: left as it is, never saved over. */
export class NewerFormatError extends Error {
  constructor(store: string, version: number) {
    super(`${store} has format version ${version}, newer than this build's ${FORMAT_VERSION}`);
    this.name = "NewerFormatError";
  }
}

/** The two header objects, ahead of a document's own keys. */
export function withHeader(kind: FileKind, writer: FileWriter, body: Record<string, unknown>): Record<string, unknown> {
  return {
    format: { owner: FILE_OWNER, kind, version: FORMAT_VERSION },
    writer: { name: writer.name, version: writer.version },
    ...body,
  };
}

/** The format version a document claims, when it names one as a positive integer. */
function claimedVersion(format: Record<string, unknown>): number | null {
  const { version } = format;
  return typeof version === "number" && Number.isInteger(version) && version >= 1 ? version : null;
}

/** Check a JSON document's header: returns when it is this kind at version 1; throws
 *  {@link NewerFormatError} for a later version and {@link InvalidManagedJsonError} otherwise. */
export function checkHeader(root: Record<string, unknown>, kind: FileKind, store: string): void {
  const format = root.format;
  if (!isPlainObject(format) || typeof format.owner !== "string" || typeof format.kind !== "string") {
    throw new InvalidManagedJsonError(store, "no valid format header");
  }
  const version = claimedVersion(format);
  if (version === null) throw new InvalidManagedJsonError(store, "no valid format version");
  if (format.owner !== FILE_OWNER || format.kind !== kind) {
    throw new InvalidManagedJsonError(store, `holds ${format.owner} ${format.kind}, not ${FILE_OWNER} ${kind}`);
  }
  if (version > FORMAT_VERSION) throw new NewerFormatError(store, version);
}

/** Whether a parsed document claims a later format version, whatever its owner or kind: the save
 *  admission never replaces such a file. */
export function isNewerFormat(root: Record<string, unknown>): boolean {
  const format = root.format;
  if (!isPlainObject(format)) return false;
  const version = claimedVersion(format);
  return version !== null && version > FORMAT_VERSION;
}

/** An unreadable or newer database: the open fails and nothing is written to it. */
export class DatabaseHeaderError extends Error {
  readonly newer: boolean;
  constructor(database: string, detail: string, newer = false) {
    super(`${database} ${detail}`);
    this.name = "DatabaseHeaderError";
    this.newer = newer;
  }
}

/** Check, or on a new empty database create, the header of a database opened for writing, and
 *  rewrite its writer rows. Runs before anything else touches the file, so a database this build
 *  cannot read is left exactly as it was. */
export function openDatabaseHeader(db: DatabaseSync, database: string, kind: FileKind, writer: FileWriter): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const tables = (db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }).n;
  if (version === 0 && tables === 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const insert = db.prepare("INSERT INTO file_header (key, value) VALUES (?, ?)");
      insert.run("format.owner", FILE_OWNER);
      insert.run("format.kind", kind);
      insert.run("writer.name", writer.name);
      insert.run("writer.version", writer.version);
      db.exec(`PRAGMA user_version = ${FORMAT_VERSION}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return;
  }
  if (version > FORMAT_VERSION) throw new DatabaseHeaderError(database, `has format version ${version}, newer than this build's ${FORMAT_VERSION}`, true);
  if (version !== FORMAT_VERSION) throw new DatabaseHeaderError(database, "has no valid format version");
  const hasHeader = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_header'").get() !== undefined;
  if (!hasHeader) throw new DatabaseHeaderError(database, "has no file header");
  const value = (key: string): unknown => (db.prepare("SELECT value FROM file_header WHERE key = ?").get(key) as { value: unknown } | undefined)?.value;
  if (value("format.owner") !== FILE_OWNER || value("format.kind") !== kind) {
    throw new DatabaseHeaderError(database, `does not hold ${FILE_OWNER} ${kind}`);
  }
  const upsert = db.prepare("INSERT INTO file_header (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  upsert.run("writer.name", writer.name);
  upsert.run("writer.version", writer.version);
}
