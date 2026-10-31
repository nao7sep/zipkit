/** The launch's read-only look at each database's header: it never changes the file it inspects. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectDatabase } from "../../../src/gui/main/refusals.js";
import { seedDatabase } from "../../helpers/fileHeader.js";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "zipkit-refusals-")); });
afterEach(() => rm(root, { recursive: true, force: true }));

describe("inspectDatabase", () => {
  const file = () => path.join(root, "records.sqlite3");
  const header = { "format.owner": "zipkit", "format.kind": "records" };

  it("accepts an absent database, a new empty one and one of this kind at version 1", () => {
    expect(inspectDatabase(file(), "records")).toBeNull();
    writeFileSync(file(), "");
    expect(inspectDatabase(file(), "records")).toBeNull();
    seedDatabase(path.join(root, "current.sqlite3"), 1, header);
    expect(inspectDatabase(path.join(root, "current.sqlite3"), "records")).toBeNull();
  });

  it.each([
    ["a newer version", 2, header, "newer"],
    ["no header", 1, undefined, "unreadable"],
    ["another owner", 1, { ...header, "format.owner": "otherapp" }, "unreadable"],
    ["another kind", 1, { ...header, "format.kind": "backups" }, "unreadable"],
  ] as const)("refuses a database with %s and leaves its bytes as they were", (_case, version, rows, reason) => {
    seedDatabase(file(), version, rows);
    const before = readFileSync(file());
    expect(inspectDatabase(file(), "records")).toEqual({ file: file(), reason });
    expect(readFileSync(file()).equals(before)).toBe(true);
  });

  it("refuses a file that is not a database at all, leaving it as it is", () => {
    writeFileSync(file(), "not a database, just text that is long enough to have a header page");
    const before = readFileSync(file());
    expect(inspectDatabase(file(), "records")).toEqual({ file: file(), reason: "unreadable" });
    expect(readFileSync(file()).equals(before)).toBe(true);
  });
});
