/**
 * Runs one backup pass and returns a {@link BackupReport}. It never throws for an expected problem (a
 * fatal error is captured in the report) and never logs — the caller logs the report. See the data-backup
 * conventions: change is size + mtime, the archive mirrors `~/.zipkit/`, and the archive is written and
 * renamed into place *before* the index so a crash never records a phantom backup.
 *
 * The archive is written with yazl — a minimal zip writer that stores each file at the exact archive path
 * it is given, with no path transform, no manifest, and no collision rename. That plainness is the point:
 * the backup is a faithful home-root mirror, so it deliberately does NOT reuse the ZipKit SDK's
 * portability-linting archiver (which rewrites paths, records a manifest, and resolves collisions) — its
 * format must not leak into this mirror or its index.
 */
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { backupIndexPath, backupsDir, collectRoots } from "./backupCollector.js";
import { selectChanged } from "./backupPlan.js";
import { formatArchivedAt, toIsoSeconds } from "./backupTime.js";
import type { BackupCandidate, BackupIndex, BackupReport, BackupSkip } from "./backupTypes.js";

/** Captures everything changed since the last run. `now` is a parameter so the archive stamp is
 *  deterministic under test. */
export async function runBackup(now: Date): Promise<BackupReport> {
  try {
    return await runCore(now);
  } catch (fatal) {
    return { nothingChanged: false, filesArchived: 0, skips: [], indexWasReset: false, fatal };
  }
}

async function runCore(now: Date): Promise<BackupReport> {
  const { index, indexWasReset } = await loadIndex();
  const { candidates, skips } = await collectRoots();

  const changed = selectChanged(candidates, index);
  if (changed.length === 0) {
    return { nothingChanged: true, filesArchived: 0, skips, indexWasReset };
  }

  const archivedAt = formatArchivedAt(now);
  const archiveFileName = `backup-${archivedAt}.zip`;
  const archived = await writeArchive(archiveFileName, changed, skips);
  if (archived.length === 0) {
    // Every changed file vanished before it could be archived; nothing was written, nothing is recorded.
    return { nothingChanged: true, filesArchived: 0, skips, indexWasReset };
  }

  for (const item of archived) {
    index.entries.push({
      archivedAt,
      archivePath: item.archivePath,
      sizeBytes: item.sizeBytes,
      lastWriteUtc: toIsoSeconds(item.mtimeMs),
    });
  }
  // Index second: the archive is already in place, so a crash here just re-captures next run. The index
  // is written 0600 (it lives in the 0700 backups dir, but owner-only on the file too costs nothing).
  await writeFileAtomic(backupIndexPath(), `${JSON.stringify(index, null, 2)}\n`);

  return { nothingChanged: false, archiveFileName, filesArchived: archived.length, skips, indexWasReset };
}

async function loadIndex(): Promise<{ index: BackupIndex; indexWasReset: boolean }> {
  const indexPath = backupIndexPath();
  let raw: string;
  try {
    raw = await fs.promises.readFile(indexPath, "utf-8");
  } catch (err) {
    // Absent index (first run, or freshly relocated root) is normal: back up everything.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { index: { entries: [] }, indexWasReset: false };
    }
    // Unreadable for another reason — treat as reset (full backup) rather than fail the run.
    return { index: { entries: [] }, indexWasReset: true };
  }

  try {
    const parsed = JSON.parse(raw) as BackupIndex;
    if (!parsed || !Array.isArray(parsed.entries)) throw new Error("malformed index");
    return { index: { entries: parsed.entries }, indexWasReset: false };
  } catch {
    // A corrupt index is deleted and treated as empty: the run becomes a full backup, costing one
    // redundant archive, never data.
    await tryDelete(indexPath);
    return { index: { entries: [] }, indexWasReset: true };
  }
}

/** Streams the changed files to a temp zip and renames it into place, returning the files that were
 *  actually archived (a file that vanished since collection is skipped, not recorded). */
async function writeArchive(
  archiveFileName: string,
  changed: readonly BackupCandidate[],
  skips: BackupSkip[],
): Promise<BackupCandidate[]> {
  const dir = await ensureBackupsDir();
  const finalPath = path.join(dir, archiveFileName);
  const tempPath = path.join(dir, `.${process.pid}-${archiveFileName}.tmp`);

  const zip = new yazl.ZipFile();
  const archived: BackupCandidate[] = [];
  for (const item of changed) {
    if (!fs.existsSync(item.sourcePath)) {
      skips.push({ path: item.archivePath, reason: "vanished before archive" });
      continue;
    }
    zip.addFile(item.sourcePath, item.archivePath);
    archived.push(item);
  }
  if (archived.length === 0) {
    return archived;
  }

  zip.end();
  try {
    await pipeline(zip.outputStream, createWriteStream(tempPath, { mode: 0o600 }));
    await fs.promises.rename(tempPath, finalPath);
  } catch (err) {
    await tryDelete(tempPath);
    throw err;
  }
  return archived;
}

async function ensureBackupsDir(): Promise<string> {
  const dir = backupsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  // Owner-only: a backup mirrors `~/.zipkit/`, so the archives must not be readable by other users even
  // though the zip itself carries the umask default (data-backup conventions). Skipped on Windows.
  if (process.platform !== "win32") {
    await fs.promises.chmod(dir, 0o700);
  }
  return dir;
}

/** Atomic write: temp file + rename, mode 0600. Mirrors the settings/queue persistence idiom, so a crash
 *  mid-write cannot corrupt the index. */
async function writeFileAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, contents, { mode: 0o600 });
  await fs.promises.rename(tmp, file);
}

async function tryDelete(target: string): Promise<void> {
  try {
    await fs.promises.rm(target, { force: true });
  } catch {
    // best effort: a leftover temp is harmless and lives under the excluded backups/ directory
  }
}
