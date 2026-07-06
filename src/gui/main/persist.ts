/**
 * Queue persistence. Only the *resumable* part of a job survives a restart —
 * inputs, options, intent — never the transient run state; restored jobs are
 * re-planned fresh. The file lives under zipkit's storage root (`ZIPKIT_HOME`
 * or `~/.zipkit`, resolved in one place by the SDK's {@link storageRoot}, beside
 * the SDK's logs). Parsing is pure and defensive (defaults missing option fields,
 * drops malformed entries, never throws) so a stale or corrupt file degrades to
 * an empty queue rather than crashing the app; the file I/O is the best-effort
 * edge.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { storageRoot } from "../../sdk/storage.js";
import { DEFAULT_OPTIONS, type GuiOptions } from "../shared/spec.js";
import type { Job, SavedJob } from "../shared/queue.js";
import { nullLog, type AppLog } from "./log.js";
import { loadManagedJson } from "./managedJson.js";

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

/** The queue document's top-level `jobs` array, or `undefined` when the text is not valid JSON or
 *  lacks an array `jobs` field — the one place that shape check lives, shared by `parseQueue` and
 *  {@link isQueueCorrupt} so the two never drift apart. */
function extractJobsArray(text: string): unknown[] | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const jobs = (doc as { jobs?: unknown } | null)?.jobs;
  return Array.isArray(jobs) ? jobs : undefined;
}

/** The queue store's corrupt-detection: invalid JSON, or valid JSON whose top-level `jobs` field is
 *  not an array — either way there is no resumable document to recover a single entry from, so the
 *  whole file is treated as corrupt (unlike a malformed individual entry within a good `jobs` array,
 *  which `parseQueue` drops and tolerates). */
export function isQueueCorrupt(text: string): boolean {
  return extractJobsArray(text) === undefined;
}

/** Parse queue-file text into resumable jobs: default missing option fields, drop
 *  malformed entries, normalize the intent. Pure; never throws. */
export function parseQueue(text: string): SavedJob[] {
  const jobs = extractJobsArray(text);
  if (!jobs) return [];

  const out: SavedJob[] = [];
  for (const entry of jobs) {
    const j = entry as { id?: unknown; inputs?: unknown; options?: unknown; intent?: unknown };
    if (typeof j.id !== "string") continue;
    if (!Array.isArray(j.inputs) || !j.inputs.every((p) => typeof p === "string")) continue;
    out.push({
      id: j.id,
      inputs: j.inputs as string[],
      options: { ...DEFAULT_OPTIONS, ...((j.options ?? {}) as Partial<GuiOptions>) },
      intent: j.intent === "archive-and-trash" ? "archive-and-trash" : "save",
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
 *  caller can log it through the session log rather than swallowing it. Corrupt
 *  *content* — invalid JSON or a missing `jobs` array, see {@link isQueueCorrupt}
 *  — is quarantined aside (never silently reset in place) before degrading to an
 *  empty queue via {@link parseQueue}; a quarantine-rename failure propagates like
 *  any other genuine I/O error on this durable store. The shared
 *  {@link loadManagedJson} owns that quarantine-outside-the-catch shape, identical
 *  to config.json and layout.json (which differ only in degrading any read error to
 *  their defaults rather than rethrowing it). */
export async function loadQueue(logger: AppLog = nullLog): Promise<SavedJob[]> {
  return loadManagedJson(queueFile(), isQueueCorrupt, parseQueue, () => [], "rethrow-non-enoent", logger);
}

/** Persist resumable jobs atomically (temp file + rename), so a crash mid-write
 *  cannot corrupt the queue. The temp is `<stem>-<nanoid>.tmp` in the same directory
 *  (storage-path conventions' derived-filename grammar). Throws on failure; the
 *  caller logs it through the session log. */
export async function saveQueue(jobs: SavedJob[]): Promise<void> {
  const file = queueFile();
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${path.parse(file).name}-${nanoid()}.tmp`);
  await writeFile(tmp, serializeQueue(jobs), "utf8");
  await rename(tmp, file);
}
