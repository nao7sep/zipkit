/**
 * The managed-write thread (./managed-write): it runs the one managed-text
 * atomic write on what it is given, posts whether it succeeded, and wakes the
 * thread waiting for it. A stalled disk blocks this thread, never that one.
 * It imports only Node built-ins and nanoid, through ./managed-write.ts, so the
 * tests run this source as it is.
 */

import { workerData } from "node:worker_threads";
import { writeManagedText, type ManagedWriteReply, type ManagedWriteWorkerData } from "./managed-write.ts";

const { file, text, signal, port, options } = workerData as ManagedWriteWorkerData;

let reply: ManagedWriteReply;
try {
  await writeManagedText(file, Buffer.from(text, "utf8"), undefined, options);
  reply = { ok: true };
} catch (error) {
  reply = { ok: false, message: error instanceof Error ? error.message : String(error) };
}
port.postMessage(reply);
port.close();
Atomics.store(signal, 0, 1);
Atomics.notify(signal, 0);
