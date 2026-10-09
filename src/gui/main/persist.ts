/**
 * Queue persistence. Only the *resumable* part of a job survives a restart —
 * inputs, options, intent — never the transient run state; restored jobs are
 * re-planned fresh. The file lives under zipkit's storage root (`ZIPKIT_DATA_DIR`
 * or `~/.zipkit`, resolved in one place by the SDK's {@link storageRoot}, beside
 * the records database). Parsing defaults absent option fields but skips malformed
 * jobs and repeated durable identities, so the readable jobs carry on while the
 * original file, with every job in it, is set aside rather than silently dropped
 * or aliased.
 */

import path from "node:path";
import { storageRoot } from "../../sdk/storage.js";
import type { Job, SavedJob } from "../shared/queue.js";
import { nullLog, type AppLog } from "./log.js";
import { InvalidManagedJsonError, isPlainObject, loadManagedJson, managedJsonText, writeManagedJson, type ManagedJsonLoad } from "./managedJson.js";
import { writeManagedTextWithin } from "./managed-write.js";
import { parseGuiOptions } from "./settings.js";

/** The queue file under the resolved storage root. Computed lazily (not frozen
 *  into a module constant at import time) so `ZIPKIT_DATA_DIR` is read after the
 *  environment is set, per the convention's caution against import-time
 *  resolution. */
function queueFile(): string {
  return path.join(storageRoot(), "queue.json");
}

/** The resumable view of a job list: specs only, terminal jobs excluded. Pure. */
export function toResumable(jobs: Job[]): SavedJob[] {
  return jobs
    .filter((j) => j.state !== "done" && j.state !== "failed")
    .map((j) => ({ id: j.id, inputs: j.inputs, options: j.options, intent: j.intent }));
}

/** The queue file's readable jobs, and how many it held that could not be read. */
export interface QueueRead {
  jobs: SavedJob[];
  skipped: number;
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
  if (j.intent !== "save" && j.intent !== "archive-and-trash") {
    throw new InvalidManagedJsonError("queue.json", "job intent is invalid");
  }
  return {
    id: j.id,
    inputs: j.inputs as string[],
    options: parseGuiOptions(j.options, "queue.json"),
    intent: j.intent,
  };
}

/** Read resumable jobs from the queue file's root object, defaulting absent option fields. A job
 *  that cannot be read, or repeats an earlier job's ID, is skipped and counted; a file whose `jobs`
 *  is not a list is unreadable as a whole. */
export function parseQueue(root: Record<string, unknown>, logger: AppLog = nullLog): QueueRead {
  if (!Array.isArray(root.jobs)) throw new InvalidManagedJsonError("queue.json", "jobs must be an array");

  const jobs: SavedJob[] = [];
  const ids = new Set<string>();
  let skipped = 0;
  for (const [index, entry] of root.jobs.entries()) {
    try {
      const job = parseJob(entry, ids);
      ids.add(job.id);
      jobs.push(job);
    } catch (err) {
      if (!(err instanceof InvalidManagedJsonError)) throw err;
      skipped++;
      logger.warn("skipped an unreadable saved job", { index, error: err.message });
    }
  }
  return { jobs, skipped };
}

/** Serialize resumable jobs to queue-file text. Pure. */
export function serializeQueue(jobs: SavedJob[]): string {
  return managedJsonText({ jobs });
}

/** Load the persisted resumable jobs. Returns an empty list when there is simply
 *  no file yet (the normal first-run case); a genuine read error is thrown so the
 *  caller can log it through the session log rather than swallowing it. A file
 *  that cannot be read at all is set aside before returning an empty queue; one
 *  with unreadable jobs is set aside whole, and its readable jobs are returned,
 *  so each job is kept on disk until the next save writes the readable ones.
 *  Failures to set aside and non-ENOENT read errors propagate. */
export async function loadQueue(logger: AppLog = nullLog): Promise<ManagedJsonLoad<QueueRead>> {
  return loadManagedJson(
    queueFile(),
    (root) => parseQueue(root, logger),
    () => ({ jobs: [], skipped: 0 }),
    logger,
    { incomplete: (read) => read.skipped > 0 },
  );
}

/** Persist resumable jobs through the shared managed-text atomic write (temp file + rename), so a crash
 *  mid-write cannot corrupt the queue. The job list is transient work, pointing at the user's files
 *  rather than holding any (developer decision), so it is not backed up. Throws on failure; the
 *  caller logs it through the session log. */
export async function saveQueue(jobs: SavedJob[]): Promise<void> {
  await writeManagedJson(queueFile(), serializeQueue(jobs));
}

/** Persist resumable jobs before returning, within `boundMs`, for the end of a Windows session,
 *  which follows as soon as its handler returns. The same atomic write runs on its own thread
 *  (managed-write.ts). Throws when the write failed or did not finish in time. */
export function saveQueueWithin(jobs: SavedJob[], boundMs: number): void {
  writeManagedTextWithin(queueFile(), serializeQueue(jobs), boundMs);
}
