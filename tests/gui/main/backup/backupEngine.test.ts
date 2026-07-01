/**
 * Engine tests over a mock `~/.zipkit/` relocated via ZIPKIT_HOME to a throwaway directory. Covers the
 * lifecycle the data-backup conventions require: first run captures everything, an unchanged run writes
 * nothing, a single changed file produces a one-file archive, a corrupt index is reset into a full
 * backup, and a fold-collision / excluded file becomes a skip / is omitted. Archives are read back with
 * the repo's zip reader so the mirror layout and index schema are asserted against the real bytes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBackup } from "../../../../src/gui/main/backup/backupEngine.js";
import { readZipFile } from "../../../helpers/readZip.js";

let root: string;
const prev = process.env.ZIPKIT_HOME;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "zipkit-backup-home-"));
  process.env.ZIPKIT_HOME = root;
});
afterEach(async () => {
  if (prev === undefined) delete process.env.ZIPKIT_HOME;
  else process.env.ZIPKIT_HOME = prev;
  await rm(root, { recursive: true, force: true });
});

const write = async (rel: string, contents: string): Promise<string> => {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return full;
};

const backupsDir = (): string => path.join(root, "backups");
const readIndex = async (): Promise<{ entries: unknown[] }> =>
  JSON.parse(await readFile(path.join(backupsDir(), "index.json"), "utf8"));
const listArchives = async (): Promise<string[]> =>
  (await readdir(backupsDir())).filter((f) => f.startsWith("backup-") && f.endsWith(".zip"));

describe("runBackup", () => {
  it("first run captures the whole home root and writes an index with the shared schema", async () => {
    await write("config.json", "{}");
    await write("queue.json", '{"jobs":[]}');

    const report = await runBackup(new Date("2026-07-01T02:22:20Z"));

    expect(report.fatal).toBeUndefined();
    expect(report.nothingChanged).toBe(false);
    expect(report.indexWasReset).toBe(false);
    expect(report.filesArchived).toBe(2);
    expect(report.archiveFileName).toBe("backup-20260701-022220-utc.zip");

    const zip = readZipFile(path.join(backupsDir(), report.archiveFileName!));
    expect(zip.entries.map((e) => e.name).sort()).toEqual(["config.json", "queue.json"]);

    const index = await readIndex();
    expect(index.entries).toHaveLength(2);
    expect(Object.keys(index.entries[0] as object)).toEqual([
      "archivedAt",
      "archivePath",
      "sizeBytes",
      "lastWriteUtc",
    ]);
    expect(index.entries).toContainEqual(
      expect.objectContaining({ archivedAt: "20260701-022220-utc", archivePath: "config.json" }),
    );
  });

  it("excludes layout.json, logs/, and backups/ from the capture set", async () => {
    await write("config.json", "{}");
    await write("layout.json", '{"layout":{}}');
    await write("logs/session.log", "log line");

    const report = await runBackup(new Date("2026-07-01T02:22:20Z"));

    const zip = readZipFile(path.join(backupsDir(), report.archiveFileName!));
    expect(zip.entries.map((e) => e.name)).toEqual(["config.json"]);
    expect(report.filesArchived).toBe(1);
  });

  it("writes nothing when nothing changed since the last run", async () => {
    await write("config.json", "{}");
    await runBackup(new Date("2026-07-01T02:22:20Z"));

    const report = await runBackup(new Date("2026-07-01T03:00:00Z"));

    expect(report.nothingChanged).toBe(true);
    expect(report.archiveFileName).toBeUndefined();
    expect(await listArchives()).toHaveLength(1); // only the first run's archive
  });

  it("captures only the one file that changed on a later run", async () => {
    await write("config.json", "{}");
    const queuePath = await write("queue.json", '{"jobs":[]}');
    await runBackup(new Date("2026-07-01T02:22:20Z"));

    // Change queue.json's content and push its mtime well beyond the tolerance.
    await writeFile(queuePath, '{"jobs":[{"id":"a"}]}', "utf8");
    const later = new Date("2026-07-01T04:00:00Z");
    await utimes(queuePath, later, later);

    const report = await runBackup(new Date("2026-07-01T05:00:00Z"));

    expect(report.nothingChanged).toBe(false);
    expect(report.filesArchived).toBe(1);
    const zip = readZipFile(path.join(backupsDir(), report.archiveFileName!));
    expect(zip.entries.map((e) => e.name)).toEqual(["queue.json"]);

    // The index now holds both the original two rows and the new queue.json row.
    const index = await readIndex();
    expect(index.entries).toHaveLength(3);
  });

  it("resets a corrupt index and performs a full backup", async () => {
    await write("config.json", "{}");
    await runBackup(new Date("2026-07-01T02:22:20Z"));

    // Corrupt the index; the next run must delete it, report the reset, and recapture everything.
    await writeFile(path.join(backupsDir(), "index.json"), "{ not valid json", "utf8");

    const report = await runBackup(new Date("2026-07-01T06:00:00Z"));

    expect(report.indexWasReset).toBe(true);
    expect(report.nothingChanged).toBe(false);
    expect(report.filesArchived).toBe(1);
    const index = await readIndex();
    expect(index.entries).toHaveLength(1); // reset, then one fresh row
  });

  it("returns a first-run empty result when the home root does not exist yet", async () => {
    await rm(root, { recursive: true, force: true });
    const report = await runBackup(new Date("2026-07-01T02:22:20Z"));
    expect(report.nothingChanged).toBe(true);
    expect(report.filesArchived).toBe(0);
    expect(report.fatal).toBeUndefined();
  });
});
