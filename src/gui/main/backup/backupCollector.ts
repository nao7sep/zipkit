/**
 * Discovers what to back up by walking zipkit's home root (`ZIPKIT_HOME` or `~/.zipkit`, resolved in one
 * place by the SDK's {@link storageRoot}), pruning the excluded subtrees and files, and stat'ing each
 * survivor. zipkit keeps no externally-linked data roots, so the home root is the whole capture set.
 * Produces the stat'd candidates for {@link selectChanged} and a skip for anything unreadable or
 * fold-colliding. All I/O here is metadata only — directory walks and `stat`; file contents are read
 * later, when a changed file is archived.
 */
import fs from "node:fs";
import path from "node:path";
import { storageRoot } from "../../../sdk/storage.js";
import { forHomeFile, normalize } from "./archivePaths.js";
import { isExcludedDir, isExcludedFile } from "./homeRootExclusions.js";
import { dedupeFoldCollisions } from "./backupPlan.js";
import { truncateToSecondMs } from "./backupTime.js";
import type { BackupCandidate, BackupSkip } from "./backupTypes.js";

export interface CollectedRoots {
  candidates: BackupCandidate[];
  skips: BackupSkip[];
}

/** The home root's `backups/` directory — where the index and archives live (data-backup conventions). */
export function backupsDir(): string {
  return path.join(storageRoot(), "backups");
}

/** The backup index file under `backups/`. */
export function backupIndexPath(): string {
  return path.join(backupsDir(), "index.json");
}

export async function collectRoots(): Promise<CollectedRoots> {
  const candidates: BackupCandidate[] = [];
  const skips: BackupSkip[] = [];
  const root = storageRoot();

  if (!fs.existsSync(root)) {
    // No home root yet (first launch before anything materialized): nothing to back up, not an error.
    return { candidates, skips };
  }

  await walk(
    root,
    root,
    skips,
    async (fullPath, relative) => {
      if (!isExcludedFile(relative)) {
        await addCandidate(candidates, skips, fullPath, forHomeFile(relative));
      }
    },
    (relativeDir) => isExcludedDir(relativeDir),
  );

  // Fold two case-only-different archive paths onto one entry (they would unzip to one file on a
  // case-insensitive filesystem); the loser becomes a skip.
  const { kept, skips: collisionSkips } = dedupeFoldCollisions(candidates);
  return { candidates: kept, skips: [...skips, ...collisionSkips] };
}

/**
 * Recursively yields each file under `root` (relative path forward-slash normalized), skipping any
 * subdirectory the `pruneDir` predicate rejects. An unreadable directory is a logged skip, not a throw,
 * so the rest of the tree is still captured.
 */
async function walk(
  root: string,
  dir: string,
  skips: BackupSkip[],
  onFile: (fullPath: string, relative: string) => Promise<void>,
  pruneDir: (relativeDir: string) => boolean,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    skips.push({ path: dir, reason: `could not enumerate: ${errorMessage(err)}` });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relative = normalize(path.relative(root, fullPath));
    if (entry.isDirectory()) {
      if (!pruneDir(relative)) {
        await walk(root, fullPath, skips, onFile, pruneDir);
      }
    } else if (entry.isFile()) {
      await onFile(fullPath, relative);
    }
  }
}

async function addCandidate(
  candidates: BackupCandidate[],
  skips: BackupSkip[],
  sourcePath: string,
  archivePath: string,
): Promise<void> {
  try {
    const stat = await fs.promises.stat(sourcePath);
    candidates.push({
      sourcePath,
      archivePath,
      sizeBytes: stat.size,
      mtimeMs: truncateToSecondMs(stat.mtimeMs),
    });
  } catch (err) {
    skips.push({ path: sourcePath, reason: `could not stat: ${errorMessage(err)}` });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
