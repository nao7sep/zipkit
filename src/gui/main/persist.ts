/**
 * Queue persistence. Only the *resumable* part of a job survives a restart —
 * inputs, options, intent — never the transient run state; restored jobs are
 * re-planned fresh. The file lives under zipkit's storage root (`ZIPKIT_DATA_DIR`
 * or `~/.zipkit`, resolved in one place by the SDK's {@link storageRoot}, beside
 * the records database). Parsing defaults absent option fields but rejects malformed
 * jobs and non-unique durable identities so recoverable bytes are quarantined
 * rather than silently dropped or aliased.
 */

import path from "node:path";
import { storageRoot } from "../../sdk/storage.js";
import type { Job, SavedJob } from "../shared/queue.js";
import { nullLog, type AppLog } from "./log.js";
import { FORMAT_VERSIONS } from "./formatVersions.js";
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

/** Read resumable jobs from the queue file's root object, defaulting absent option
 * fields and rejecting malformed entries or duplicate/empty IDs as one invalid snapshot. */
export function parseQueue(root: Record<string, unknown>): SavedJob[] {
  if (!Array.isArray(root.jobs)) throw new InvalidManagedJsonError("queue.json", "jobs must be an array");

  const out: SavedJob[] = [];
  const ids = new Set<string>();
  for (const entry of root.jobs) {
    if (!isPlainObject(entry)) throw new InvalidManagedJsonError("queue.json", "every job must be an object");
    const j = entry;
    if (typeof j.id !== "string" || j.id === "" || ids.has(j.id)) {
      throw new InvalidManagedJsonError("queue.json", "job IDs must be non-empty and unique");
    }
    ids.add(j.id);
    if (!Array.isArray(j.inputs) || j.inputs.length === 0 || !j.inputs.every((p) => typeof p === "string" && p !== "")) {
      throw new InvalidManagedJsonError("queue.json", "job inputs must be a non-empty array of non-empty strings");
    }
    if (j.intent !== "save" && j.intent !== "archive-and-trash") {
      throw new InvalidManagedJsonError("queue.json", "job intent is invalid");
    }
    out.push({
      id: j.id,
      inputs: j.inputs as string[],
      options: parseGuiOptions(j.options, "queue.json"),
      intent: j.intent,
    });
  }
  return out;
}

/** Serialize resumable jobs to queue-file text. Pure. */
export function serializeQueue(jobs: SavedJob[]): string {
  return managedJsonText(FORMAT_VERSIONS.queue, { jobs });
}

/** Load the persisted resumable jobs. Returns an empty list when there is simply
 *  no file yet (the normal first-run case); a genuine read error is thrown so the
 *  caller can log it through the session log rather than swallowing it. Invalid
 *  content is quarantined before returning an empty queue; a newer format,
 *  quarantine failures, and non-ENOENT read errors propagate. */
export async function loadQueue(logger: AppLog = nullLog): Promise<ManagedJsonLoad<SavedJob[]>> {
  return loadManagedJson(queueFile(), FORMAT_VERSIONS.queue, parseQueue, () => [], logger);
}

/** Persist resumable jobs through the shared managed-text atomic write (temp file + rename), so a crash
 *  mid-write cannot corrupt the queue, and the exact bytes are recorded to the data-backup store after
 *  the rename lands. queue.json is the user's own in-progress work — managed text — and RECORDS on every
 *  save (data-backup conventions). Throws on failure; the caller logs it through the session log. */
export async function saveQueue(jobs: SavedJob[]): Promise<void> {
  await writeManagedJson(queueFile(), serializeQueue(jobs));
}

/** Persist resumable jobs before returning, within `boundMs`, for the end of a Windows session,
 *  which follows as soon as its handler returns. The same atomic write runs on its own thread
 *  (managed-write.ts); the data-backup record is skipped, because the session ends before the
 *  backups thread could take it. Throws when the write failed or did not finish in time. */
export function saveQueueWithin(jobs: SavedJob[], boundMs: number): void {
  writeManagedTextWithin(queueFile(), serializeQueue(jobs), boundMs);
}
