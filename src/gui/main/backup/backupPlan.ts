/**
 * The pure change decision: given the current candidates and the existing index, return the ones a run
 * must capture. A candidate is captured when its `(size, mtime)` differs from the latest recorded state
 * for its archive path — where two modification times within {@link MTIME_MATCH_TOLERANCE_MS} count as
 * equal. No content hashing (see the data-backup conventions): every real edit moves the mtime, and the
 * tolerance absorbs FAT/exFAT's two-second granularity on USB drives.
 *
 * Also the pure fold-collision resolution: two candidates whose archive paths differ only by case would
 * unzip to one file on a case-insensitive filesystem, so one is kept and the other becomes a skip
 * (case-insensitive entry uniqueness — data-backup conventions). Kept pure so both decisions are
 * unit-testable without touching the filesystem.
 */
import type { BackupCandidate, BackupIndex, BackupIndexEntry, BackupSkip } from "./backupTypes.js";

/**
 * The modification-time equality window, in milliseconds. Two seconds absorbs FAT/exFAT's 2-second mtime
 * granularity (a file may live on a USB stick); it costs nothing in missed edits because the recorded
 * time is from a prior backup run, which any real edit moves well beyond two seconds past.
 */
export const MTIME_MATCH_TOLERANCE_MS = 2000;

/** Returns the candidates whose size or modification time differs from the latest index entry for their
 *  archive path (a candidate with no prior entry is always new). */
export function selectChanged(
  candidates: readonly BackupCandidate[],
  index: BackupIndex,
): BackupCandidate[] {
  const latest = latestByPath(index);
  return candidates.filter((candidate) => isChanged(candidate, latest));
}

/**
 * Drop candidates whose archive path collides case-insensitively with one already kept: the first is
 * kept, each later one is recorded as a skip. Pure — returns the surviving set and the skips it produced.
 */
export function dedupeFoldCollisions(candidates: readonly BackupCandidate[]): {
  kept: BackupCandidate[];
  skips: BackupSkip[];
} {
  const kept: BackupCandidate[] = [];
  const skips: BackupSkip[] = [];
  const seen = new Map<string, string>();
  for (const candidate of candidates) {
    const fold = candidate.archivePath.toLowerCase();
    const existing = seen.get(fold);
    if (existing !== undefined) {
      skips.push({
        path: candidate.archivePath,
        reason: `case-insensitive path collision with ${existing}`,
      });
      continue;
    }
    seen.set(fold, candidate.archivePath);
    kept.push(candidate);
  }
  return { kept, skips };
}

function isChanged(candidate: BackupCandidate, latest: Map<string, BackupIndexEntry>): boolean {
  const entry = latest.get(candidate.archivePath);
  if (!entry) return true;
  if (entry.sizeBytes !== candidate.sizeBytes) return true;

  // A stored timestamp that cannot be parsed (a hand-mangled index) is treated as a mismatch, so the file
  // is recaptured rather than silently trusted.
  const recordedMs = Date.parse(entry.lastWriteUtc);
  if (Number.isNaN(recordedMs)) return true;

  return Math.abs(candidate.mtimeMs - recordedMs) > MTIME_MATCH_TOLERANCE_MS;
}

/** The latest entry per archive path. `archivedAt` is a `yyyymmdd-hhmmss-utc` stamp, so ordinal string
 *  comparison is chronological. */
function latestByPath(index: BackupIndex): Map<string, BackupIndexEntry> {
  const latest = new Map<string, BackupIndexEntry>();
  for (const entry of index.entries) {
    const current = latest.get(entry.archivePath);
    if (!current || entry.archivedAt >= current.archivedAt) {
      latest.set(entry.archivePath, entry);
    }
  }
  return latest;
}
