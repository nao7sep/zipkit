/**
 * The managed-text atomic write itself, apart from the data-backup record that
 * `writeManagedJson` (./managedJson) adds after it. It lives here, importing
 * only Node built-ins and nanoid, so the managed-write thread
 * (./managed-write-worker) runs this same write; there is no second atomic
 * write in the app.
 */

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { nanoid } from "nanoid";

/**
 * Writes `bytes` to a same-directory temp named `<stem>-<nanoid>.tmp`, then atomically renames it
 * over `file` (storage-path conventions), carrying an existing file's permission mode to the temp
 * first so the replace keeps it (content-lifecycle conventions). Content identical to what is on
 * disk is not written again (content-lifecycle conventions). Resolves `true` when the file was
 * written, `false` when it already held these bytes; throws on failure.
 */
export async function writeManagedText(file: string, bytes: Buffer): Promise<boolean> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const current = await readFile(file).catch(() => null);
  if (current !== null && current.equals(bytes)) return false;
  const tmp = path.join(dir, `${path.parse(file).name}-${nanoid()}.tmp`);
  try {
    await writeFile(tmp, bytes);
    const existing = await stat(file).catch(() => null);
    if (existing) await chmod(tmp, existing.mode & 0o7777).catch(() => {});
    await rename(tmp, file);
  } catch (err) {
    // A failed write removes its own unpublished temp; the write's error is the one reported.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return true;
}

/** What the managed-write thread is given. */
export interface ManagedWriteWorkerData {
  file: string;
  text: string;
  /** Set to 1 and notified once the reply is posted. */
  signal: Int32Array;
  /** Where the one reply goes. */
  port: MessagePort;
}

export type ManagedWriteReply = { ok: true } | { ok: false; message: string };

/** The bundled app runs electron-vite's `managed-write-worker.js` beside this chunk; the tests run
 *  the source, which Node loads with its own type stripping. */
function workerUrl(): URL {
  const file = import.meta.url.endsWith(".ts") ? "./managed-write-worker.ts" : "./managed-write-worker.js";
  return new URL(file, import.meta.url);
}

/**
 * Writes `text` to `file` with {@link writeManagedText} on a thread of its own, and blocks this
 * thread until it answers or `boundMs` passes. For the one caller whose work must be finished
 * before its handler returns: Windows ends the session as soon as the main window's `session-end`
 * handler does, and an asynchronous write could not finish before then. A write that has not
 * answered is abandoned; its outcome is unknown. Throws when the write failed or did not answer.
 */
export function writeManagedTextWithin(file: string, text: string, boundMs: number, url: URL = workerUrl()): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const { port1, port2 } = new MessageChannel();
  let worker: Worker;
  try {
    worker = new Worker(url, {
      workerData: { file, text, signal, port: port2 } satisfies ManagedWriteWorkerData,
      transferList: [port2],
    });
  } catch (error) {
    port1.close();
    throw error;
  }
  worker.unref();
  // A thread that fails to load or throws sends no reply, which reads as no answer.
  worker.on("error", () => {});
  Atomics.wait(signal, 0, 0, boundMs);
  const reply = receiveMessageOnPort(port1)?.message as ManagedWriteReply | undefined;
  port1.close();
  void worker.terminate();
  if (reply === undefined) throw new Error(`the write of ${file} did not finish within ${boundMs} ms`);
  if (!reply.ok) throw new Error(reply.message);
}
