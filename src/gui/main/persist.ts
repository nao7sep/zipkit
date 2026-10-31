/**
 * Queue persistence. Only the *resumable* part of a job survives a restart —
 * inputs and options — never the transient run state or the run's intent;
 * restored jobs are re-planned fresh and verify and keep their originals. The file lives under zipkit's storage root (`ZIPKIT_DATA_DIR`
 * or `~/.zipkit`, resolved in one place by the SDK's {@link storageRoot}, beside
 * the records database). Parsing defaults absent option fields. A malformed job,
 * or one that repeats an earlier job's identity, is not restored but kept exactly
 * as written, and every save writes it back after the live jobs, so nothing the
 * file held is dropped or aliased.
 */

import path from "node:path";
import { storageRoot } from "./storage.js";
import type { Job, SavedJob } from "../shared/queue.js";
import { nullLog, type AppLog } from "./log.js";
import { InvalidManagedJsonError, isPlainObject, loadManagedJson, managedJsonText, writeManagedJson, type ManagedJsonLoad } from "./managedJson.js";
import { writeManagedTextWithin } from "./managed-write.js";
import { parseGuiOptions } from "./settings.js";

/** The queue file under the resolved storage root. Computed lazily (not frozen
 *  into a module constant at import time) so `ZIPKIT_DATA_DIR` is read after the
 *  environment is set, per the convention's caution against import-time
 *  resolution. */
export function queueFile(): string {
  return path.join(storageRoot(), "queue.json");
}

/** The resumable view of a job list: specs only, terminal jobs excluded. Pure. */
export function toResumable(jobs: Job[]): SavedJob[] {
  return jobs
    .filter((j) => j.state !== "done" && j.state !== "failed")
    .map((j) => ({ id: j.id, inputs: j.inputs, options: j.options }));
}

/** The queue file's readable jobs, and the entries it held that could not be read, as written. */
export interface QueueRead {
  jobs: SavedJob[];
  kept: unknown[];
}

/** One saved job, or an error naming what makes it unreadable. */
function parseJob(entry: unknown, ids: Set<string>): SavedJob {
  if (!isPlainObject(entry)) throw new InvalidManagedJsonError("queue.json", "every job must be an object");
  const j = entry;
  if (typeof j.id !== "string" || j.id === "" || ids.has(j.id)) {
    throw new InvalidManagedJsonError("queue.json", "job IDs must be non-empty and unique");
  }
  if (!Array.isArray(j.inputs) || j.inputs.length === 0 || !j.inputs.every((p) => typeof p === "string" && p !== "")) {
    throw new InvalidManagedJsonError("queue.json", "job inputs must be a non-empty array of non-empty strings");
  }
  return {
    id: j.id,
    inputs: j.inputs as string[],
    options: parseGuiOptions(j.options, "queue.json"),
  };
}

/** Read resumable jobs from the queue file's root object, defaulting absent option fields. A job
 *  that cannot be read, or repeats an earlier job's ID, is kept as written; a file whose `jobs` is
 *  not a list is unreadable as a whole. */
export function parseQueue(root: Record<string, unknown>, logger: AppLog = nullLog): QueueRead {
  if (!Array.isArray(root.jobs)) throw new InvalidManagedJsonError("queue.json", "jobs must be an array");

  const jobs: SavedJob[] = [];
  const kept: unknown[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of root.jobs.entries()) {
    try {
      const job = parseJob(entry, ids);
      ids.add(job.id);
      jobs.push(job);
    } catch (err) {
      if (!(err instanceof InvalidManagedJsonError)) throw err;
      kept.push(entry);
      logger.warn("kept an unreadable saved job as written", { index, error: err.message });
    }
  }
  return { jobs, kept };
}

/** Serialize resumable jobs to queue-file text, the unreadable entries the file held after them. Pure. */
export function serializeQueue(jobs: SavedJob[], kept: readonly unknown[] = []): string {
  return managedJsonText("queue", { jobs: [...jobs, ...kept] });
}

/** The unreadable entries the loaded file held, written back by every save. */
let keptJobs: readonly unknown[] = [];
/** The loaded file was refused: no save may reach it (store-recovery conventions). */
let refusedFile: string | null = null;

function admitSave(): void {
  if (refusedFile !== null) throw new Error(`${refusedFile} was refused at launch and is not saved over`);
}

/** Load the persisted resumable jobs once, at startup. An absent file is an empty queue (the normal
 *  first run); a newer or unreadable file is refused and left as it is, for the launch to stop on.
 *  Read errors other than absence propagate. */
export async function loadQueue(logger: AppLog = nullLog): Promise<ManagedJsonLoad<QueueRead>> {
  const load = await loadManagedJson(
    queueFile(),
    "queue",
    (root) => parseQueue(root, logger),
    () => ({ jobs: [], kept: [] }),
    logger,
  );
  keptJobs = load.value.kept;
  refusedFile = load.refused?.file ?? null;
  return load;
}

/** Persist resumable jobs through the shared managed-text atomic write (temp file + rename), so a crash
 *  mid-write cannot corrupt the queue. The job list is transient work, pointing at the user's files
 *  rather than holding any (developer decision), so it is not backed up. Throws on failure; the
 *  caller logs it through the session log. */
export async function saveQueue(jobs: SavedJob[]): Promise<void> {
  admitSave();
  await writeManagedJson(queueFile(), serializeQueue(jobs, keptJobs), { kind: "queue" });
}

/** Persist resumable jobs before returning, within `boundMs`, for the end of a Windows session,
 *  which follows as soon as its handler returns. The same atomic write runs on its own thread
 *  (managed-write.ts). Throws when the write failed or did not finish in time. */
export function saveQueueWithin(jobs: SavedJob[], boundMs: number): void {
  admitSave();
  writeManagedTextWithin(queueFile(), serializeQueue(jobs, keptJobs), boundMs, undefined, { kind: "queue" });
}
