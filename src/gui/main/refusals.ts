/**
 * Refused files at launch (store-recovery conventions, What a refused file does).
 * A newer file of any kind, or an unreadable settings or queue file, stops the
 * launch with one message naming each; an unreadable records or backups database
 * is switched off for the session with a notice instead. Nothing here writes: a
 * database is opened read-only to read its header.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { databaseVerdict, type FileKind } from "./file-header.js";

/** A file the app will not use: one a newer format wrote, or one it cannot read. It is never
 *  changed (store-recovery conventions, A refused file is never changed). */
export interface Refusal {
  file: string;
  reason: "newer" | "unreadable";
}

/** The launch stops on these files; the startup failure names each. */
export class LaunchRefusal extends Error {
  readonly refusals: readonly Refusal[];
  constructor(refusals: readonly Refusal[]) {
    super(`launch refused: ${refusals.map((r) => `${r.file} (${r.reason})`).join(", ")}`);
    this.name = "LaunchRefusal";
    this.refusals = refusals;
  }
}

/** A database's refusal, or null when it is absent, new or this build's. Opened read-only, so an
 *  unusable file is left exactly as it is. */
export function inspectDatabase(file: string, kind: FileKind): Refusal | null {
  if (!existsSync(file)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const verdict = databaseVerdict(db, kind);
    if (typeof verdict !== "object") return null;
    return { file, reason: "newer" in verdict ? "newer" : "unreadable" };
  } catch {
    return { file, reason: "unreadable" };
  } finally {
    try { db?.close(); } catch { /* the verdict is the actionable part */ }
  }
}
