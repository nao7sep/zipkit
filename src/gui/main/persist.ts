/**
 * Queue persistence. Only the *resumable* part of a job survives a restart —
 * inputs, options, intent — never the transient run state; restored jobs are
 * re-planned fresh. The file lives under zipkit's storage root (`ZIPKIT_HOME`
 * or `~/.zipkit`, resolved in one place by the SDK's {@link storageRoot}, beside
 * the SDK's logs). Parsing defaults absent option fields but rejects malformed
 * jobs and non-unique durable identities so recoverable bytes are quarantined
 * rather than silently dropped or aliased.
 */

import path from "node:path";
import { storageRoot } from "../../sdk/storage.js";
import type { Job, SavedJob } from "../shared/queue.js";
import { nullLog, type AppLog } from "./log.js";
import { InvalidManagedJsonError, isPlainObject, loadManagedJson, parseManagedObject, writeManagedJson, type ManagedJsonLoad } from "./managedJson.js";
import { parseGuiOptions } from "./settings.js";

/** The queue file under the resolved storage root. Computed lazily (not frozen
 *  into a module constant at import time) so `ZIPKIT_HOME` is read after the
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

/** Parse queue-file text into resumable jobs, defaulting absent option fields and
 * rejecting malformed entries or duplicate/empty IDs as one invalid snapshot. */
export function parseQueue(text: string): SavedJob[] {
  const root = parseManagedObject(text, "queue.json");
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
  return JSON.stringify({ version: 1, jobs }, null, 2);
}

/** Load the persisted resumable jobs. Returns an empty list when there is simply
 *  no file yet (the normal first-run case); a genuine read error is thrown so the
 *  caller can log it through the session log rather than swallowing it. Invalid
 *  v1 content is quarantined before returning an empty queue; future versions,
 *  quarantine failures, and non-ENOENT read errors propagate. */
export async function loadQueue(logger: AppLog = nullLog): Promise<ManagedJsonLoad<SavedJob[]>> {
  return loadManagedJson(queueFile(), parseQueue, () => [], logger);
}

/** Persist resumable jobs through the shared managed-text atomic write (temp file + rename), so a crash
 *  mid-write cannot corrupt the queue, and the exact bytes are recorded to the data-backup store after
 *  the rename lands. queue.json is the user's own in-progress work — managed text — and RECORDS on every
 *  save (data-backup conventions). Throws on failure; the caller logs it through the session log. */
export async function saveQueue(jobs: SavedJob[]): Promise<void> {
  await writeManagedJson(queueFile(), serializeQueue(jobs));
}
