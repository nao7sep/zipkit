/** Store documents as this build writes them: the file header, then the store's own keys. */

import { DatabaseSync } from "node:sqlite";
import { withHeader, type FileKind } from "../../src/gui/main/file-header.js";
import { APP_PACKAGE, APP_VERSION } from "../../src/gui/shared/identity.js";

export function headed(kind: FileKind, body: Record<string, unknown> = {}): Record<string, unknown> {
  return withHeader(kind, { name: APP_PACKAGE, version: APP_VERSION }, body);
}

export function headedText(kind: FileKind, body: Record<string, unknown> = {}): string {
  return JSON.stringify(headed(kind, body));
}

/** A database as a build may have left it: `user_version`, and a `file_header` table with these
 *  rows when `rows` is given. */
export function seedDatabase(file: string, version: number, rows?: Record<string, string>): void {
  const db = new DatabaseSync(file);
  try {
    if (rows !== undefined) {
      db.exec("CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const insert = db.prepare("INSERT INTO file_header (key, value) VALUES (?, ?)");
      for (const [key, value] of Object.entries(rows)) insert.run(key, value);
    }
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

/** A database's `user_version` and header rows, read without changing it. */
export function databaseHeader(file: string): { version: number; rows: Record<string, string> } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'file_header'").get() !== undefined;
    const rows = table ? db.prepare("SELECT key, value FROM file_header ORDER BY key").all() as { key: string; value: string }[] : [];
    return { version, rows: Object.fromEntries(rows.map((row) => [row.key, row.value])) };
  } finally {
    db.close();
  }
}
