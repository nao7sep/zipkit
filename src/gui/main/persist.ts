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

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "../../sdk/storage.js";
import { DEFAULT_OPTIONS, type GuiOptions } from "../shared/spec.js";
import type { Job, SavedJob } from "../shared/queue.js";

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

/** Parse queue-file text into resumable jobs: default missing option fields, drop
 *  malformed entries, normalize the intent. Pure; never throws. */
export function parseQueue(text: string): SavedJob[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const jobs = (doc as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(jobs)) return [];

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

/** Load the persisted resumable jobs; an empty list if there is no readable file. */
export async function loadQueue(): Promise<SavedJob[]> {
  try {
    return parseQueue(await readFile(queueFile(), "utf8"));
  } catch {
    return [];
  }
}

/** Persist resumable jobs atomically (temp file + rename), so a crash mid-write
 *  cannot corrupt the queue. Best-effort and non-fatal: a write failure is
 *  surfaced to the console, never thrown. */
export async function saveQueue(jobs: SavedJob[]): Promise<void> {
  const file = queueFile();
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, serializeQueue(jobs), "utf8");
    await rename(tmp, file);
  } catch (err) {
    console.error("zipkit: failed to persist the queue:", err);
  }
}
